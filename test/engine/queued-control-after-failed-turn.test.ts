import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    EngineEventBus,
    type EngineEvent,
} from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import {
    InboundCommandRouter,
    type InboundCommandRouterOptions,
} from "../../src/engine/inbound-command-router.ts";
import {
    createInProcessChannel,
    type MessageChannel,
} from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import type { EngineCommand } from "../../src/engine/timeline-control.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const failure = {
    kind: "timeout" as const,
    resolution: "retry" as const,
    message: "No response from faux for 300s",
};

function stopMessage(model: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "test", model },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function failureMessage(model: string): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: { provider: "faux", api: "test", model },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: failure.message,
    };
}

function userTexts(store: SessionStore): string[] {
    return store.messages().flatMap((message) =>
        message.role !== "user"
            ? []
            : message.content.flatMap((block) =>
                block.type === "text" ? [block.text] : []
            )
    );
}

interface Harness {
    readonly root: string;
    readonly path: string;
    readonly store: SessionStore;
    readonly channel: MessageChannel<EngineCommand, AgentUpdate>;
    readonly inbound: InboundCommandRouter;
    readonly state: RunTurnState;
    readonly events: EngineEventBus;
    readonly observed: EngineEvent[];
    readonly requests: ModelRequest[];
    readonly adapter: ModelAdapter;
    readonly firstRequest: Promise<void>;
    readonly failFirst: () => void;
    succeeding: boolean;
}

async function createHarness(
    options: InboundCommandRouterOptions = {},
): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), "vera-stranded-control-"));
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "stranded-control",
        cwd: root,
    });
    const transport = createInProcessChannel();
    const channel = transport.client as MessageChannel<
        EngineCommand,
        AgentUpdate
    >;
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe((event) => observed.push(event));
    const inbound = new InboundCommandRouter(transport.engine, events, {
        appendQueuedPrompt: (id, prompt) =>
            store.appendQueuedPrompt(id, {
                content: prompt.content,
                ...(prompt.attachmentIds === undefined
                    ? {}
                    : { attachmentIds: prompt.attachmentIds }),
            }),
        removeQueuedPrompt: (id) => store.removeQueuedPrompt(id),
        ...options,
    });
    const requests: ModelRequest[] = [];
    let firstStream!: ModelEventStream;
    let openFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
        openFirstRequest = resolve;
    });
    const harness = {
        succeeding: false,
    } as Harness;
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            const stream = new ModelEventStream();
            if (harness.succeeding) {
                stream.push({ type: "done", message: stopMessage(request.model) });
                return stream;
            }
            if (requests.length === 1) {
                firstStream = stream;
                openFirstRequest();
                return stream;
            }
            stream.push({
                type: "error",
                error: new ProviderFailureError(
                    failure,
                    new Error(failure.message),
                ),
                message: failureMessage(request.model),
            });
            return stream;
        },
    };
    const state: RunTurnState = {
        messages: [...store.messages()],
        store,
        toolRuntime: new ToolRuntime(root),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        loadOptionalContext: false,
        waitForModelRetry: async () => {},
    };
    return Object.assign(harness, {
        root,
        path,
        store,
        channel,
        inbound,
        state,
        events,
        observed,
        requests,
        adapter,
        firstRequest,
        failFirst: () => {
            firstStream.push({
                type: "error",
                error: new ProviderFailureError(
                    failure,
                    new Error(failure.message),
                ),
                message: failureMessage("faux"),
            });
        },
    });
}

async function closeHarness(harness: Harness): Promise<void> {
    await harness.inbound.stopReceivingCommands();
    await harness.state.toolRuntime.close();
    rmSync(harness.root, { recursive: true, force: true });
}

test("@core a select queued during a failed turn is refused once and the next prompt runs", async () => {
    let selected: string | undefined;
    const harness = await createHarness({
        selectAgent: async (name) => {
            selected = name;
            return { name };
        },
    });
    try {
        harness.channel.send({ type: "prompt", content: "first" });
        const firstTurn = runTurn(harness.adapter, "faux", harness.state);
        await harness.firstRequest;
        harness.channel.send({
            type: "select_agent",
            requestId: "select-reader",
            name: "reader",
        });
        await Bun.sleep(5);
        harness.failFirst();
        expect((await firstTurn).stopReason).toBe("error");
        expect(selected).toBeUndefined();

        expect(harness.observed.filter((event) =>
            event.type === "agent_rejected"
        )).toEqual([{
            type: "agent_rejected",
            requestId: "select-reader",
            reason:
                "The turn did not finish, so the switch to reader was not applied. Select it again.",
        }]);

        harness.succeeding = true;
        harness.channel.send({ type: "prompt", content: "second" });
        const secondTurn = await runTurn(
            harness.adapter,
            "faux",
            harness.state,
        );
        expect(secondTurn.stopReason).toBe("stop");

        const reopened = await SessionStore.open(harness.path);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(userTexts(reopened)).toEqual(["first", "second"]);
    } finally {
        await closeHarness(harness);
    }
});

test("@core a skill queued during a failed turn is refused once and the next prompt runs", async () => {
    let invoked: string | undefined;
    const harness = await createHarness({
        invokeSkill: async (name) => {
            invoked = name;
            return { allowed: true };
        },
    });
    try {
        harness.channel.send({ type: "prompt", content: "first" });
        const firstTurn = runTurn(harness.adapter, "faux", harness.state);
        await harness.firstRequest;
        harness.channel.send({
            type: "invoke_skill",
            requestId: "invoke-deploy",
            name: "deploy",
            argumentsText: "staging",
        });
        await Bun.sleep(5);
        harness.failFirst();
        expect((await firstTurn).stopReason).toBe("error");
        expect(invoked).toBeUndefined();

        expect(harness.observed.filter((event) =>
            event.type === "skill_invocation_rejected"
        )).toEqual([{
            type: "skill_invocation_rejected",
            requestId: "invoke-deploy",
            name: "deploy",
            reason:
                "The turn did not finish, so /deploy did not run. Run it again.",
        }]);

        harness.succeeding = true;
        harness.channel.send({ type: "prompt", content: "second" });
        const secondTurn = await runTurn(
            harness.adapter,
            "faux",
            harness.state,
        );
        expect(secondTurn.stopReason).toBe("stop");

        const reopened = await SessionStore.open(harness.path);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(userTexts(reopened)).toEqual(["first", "second"]);
    } finally {
        await closeHarness(harness);
    }
});

test("@core a prompt queued beside a select and a skill stays held when the turn fails", async () => {
    let selected: string | undefined;
    let invoked: string | undefined;
    const harness = await createHarness({
        selectAgent: async (name) => {
            selected = name;
            return { name };
        },
        invokeSkill: async (name) => {
            invoked = name;
            return { allowed: true };
        },
    });
    try {
        harness.channel.send({ type: "prompt", content: "first" });
        const firstTurn = runTurn(harness.adapter, "faux", harness.state);
        await harness.firstRequest;
        harness.channel.send({
            type: "select_agent",
            requestId: "select-reader",
            name: "reader",
        });
        harness.channel.send({
            type: "invoke_skill",
            requestId: "invoke-deploy",
            name: "deploy",
            argumentsText: "",
        });
        harness.channel.send({ type: "prompt", content: "second" });
        await Bun.sleep(5);
        harness.failFirst();
        expect((await firstTurn).stopReason).toBe("error");

        expect(harness.observed.filter((event) =>
            event.type === "agent_rejected"
            || event.type === "skill_invocation_rejected"
        ).map((event) => event.type)).toEqual([
            "agent_rejected",
            "skill_invocation_rejected",
        ]);
        expect(selected).toBeUndefined();
        expect(invoked).toBeUndefined();

        const held = await SessionStore.open(harness.path);
        expect(held.queuedPrompts().map((prompt) => prompt.content)).toEqual([
            "second",
        ]);

        harness.succeeding = true;
        const secondTurn = runTurn(harness.adapter, "faux", harness.state);
        harness.channel.send({ type: "release_queued_prompts", mode: "one" });
        const reply = await secondTurn;
        expect(reply.stopReason).toBe("stop");
        expect(harness.requests.at(-1)?.messages.flatMap((message) =>
            message.role !== "user"
                ? []
                : message.content.flatMap((block) =>
                    block.type === "text" ? [block.text] : []
                )
        )).toContain("second");

        const reopened = await SessionStore.open(harness.path);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(userTexts(reopened)).toEqual(["first", "second"]);
    } finally {
        await closeHarness(harness);
    }
});

test("@core an aborted turn also drops the select queued during it", async () => {
    let selected: string | undefined;
    const harness = await createHarness({
        selectAgent: async (name) => {
            selected = name;
            return { name };
        },
    });
    try {
        harness.channel.send({ type: "prompt", content: "first" });
        const firstTurn = runTurn(harness.adapter, "faux", harness.state);
        await harness.firstRequest;
        harness.channel.send({
            type: "select_agent",
            requestId: "select-reader",
            name: "reader",
        });
        await Bun.sleep(5);
        harness.channel.send({ type: "abort" });
        expect((await firstTurn).stopReason).toBe("aborted");
        expect(selected).toBeUndefined();
        expect(harness.observed.filter((event) =>
            event.type === "agent_rejected"
        )).toHaveLength(1);

        harness.succeeding = true;
        harness.channel.send({ type: "prompt", content: "second" });
        const secondTurn = await runTurn(
            harness.adapter,
            "faux",
            harness.state,
        );
        expect(secondTurn.stopReason).toBe("stop");

        const reopened = await SessionStore.open(harness.path);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(userTexts(reopened)).toEqual(["first", "second"]);
    } finally {
        await closeHarness(harness);
    }
});
