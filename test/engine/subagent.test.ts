import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createSubagentEffectApplier,
    runSubagent,
} from "../../src/engine/subagent.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

test("two real subagent effects overlap and create separate sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-siblings-"));
    const sessionPaths: string[] = [];
    const childRequests: ModelRequest[] = [];
    let activeChildren = 0;
    let maximumActiveChildren = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            childRequests.push(request);
            const prompt = firstText(request.messages[0]);
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            activeChildren += 1;
            maximumActiveChildren = Math.max(
                maximumActiveChildren,
                activeChildren,
            );
            void (async () => {
                await Bun.sleep(prompt.startsWith("slow") ? 30 : 5);
                activeChildren -= 1;
                stream.push({
                    type: "done",
                    message: {
                        role: "assistant",
                        content: [{ type: "text", text: `${prompt} result` }],
                        source: {
                            provider: "faux",
                            api: "concurrent",
                            model: "test",
                        },
                        usage: emptyUsage(),
                        stopReason: "stop",
                    },
                });
            })();
            return stream;
        },
    };
    const applyEffect = createSubagentEffectApplier({
        adapter,
        model: "test",
        workspace: root,
        approvalMode: "approve_for_me",
        sessionPathForId(id) {
            const path = join(root, `${id}.jsonl`);
            sessionPaths.push(path);
            return path;
        },
    });
    const signal = new AbortController().signal;

    try {
        const results = await Promise.all([
            applyEffect({
                type: "spawn_subagent",
                description: "slow child",
            }, signal),
            applyEffect({
                type: "spawn_subagent",
                description: "fast child",
            }, signal),
        ]);

        expect(maximumActiveChildren).toBe(2);
        expect(results.map((result) => result.output)).toEqual([
            "slow child result",
            "fast child result",
        ]);
        expect(sessionPaths).toHaveLength(2);
        const childPrompts: string[] = [];
        for (const path of sessionPaths) {
            const messages = (await SessionStore.open(path)).messages();
            childPrompts.push(firstText(messages[0]));
        }
        expect(childPrompts.sort()).toEqual(["fast child", "slow child"]);
        for (const request of childRequests) {
            expect(request.tools?.map((tool) => tool.name)).not.toContain(
                "subagent",
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function firstText(message: ModelMessage | undefined): string {
    const block = message?.content[0];
    return block?.type === "text" ? block.text : "";
}

test("parent receives the real child final text as its tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-parent-"));
    let childSessionPath: string | undefined;
    const parentToolCall: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_child",
            name: "subagent",
            input: { description: "Trace the request path" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const childFinal: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "The socket reaches the registry." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const parentFinal: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "The child traced it." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const adapter = new FauxAdapter([parentToolCall, childFinal, parentFinal]);
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(root),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
        applyToolEffect: createSubagentEffectApplier({
            adapter,
            model: "test",
            workspace: root,
            approvalMode: "approve_for_me",
            sessionPathForId(id) {
                childSessionPath = join(root, `${id}.jsonl`);
                return childSessionPath;
            },
        }),
    };

    try {
        channel.client.send({ type: "prompt", content: "Delegate this" });
        const turn = runTurn(adapter, "test", state);
        while ((await channel.client.receive()).type !== "turn_finished") {
            // Drain the parent updates while both loops run.
        }

        expect(await turn).toEqual(parentFinal);
        const toolResult = state.messages.find(
            (message) => message.role === "tool_result",
        );
        expect(toolResult?.content[0]?.text).toBe(
            "The socket reaches the registry.",
        );
        expect(childSessionPath).toBeString();
        const childMessages = (await SessionStore.open(childSessionPath!))
            .messages();
        expect(childMessages).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "Trace the request path" }],
            },
            childFinal,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("subagent uses fresh context, ordinary tools, and a durable session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-"));
    const sessionPath = join(root, "child.jsonl");
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "thinking", text: "private working" },
            { type: "text", text: "The request enters through the socket." },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };

    try {
        const result = await runSubagent({
            adapter,
            model: "test",
            description: "Trace the request path",
            workspace: root,
            approvalMode: "approve_for_me",
            sessionId: "child-1",
            sessionPath,
        });

        expect(result).toEqual({
            text: "The request enters through the socket.",
            sessionId: "child-1",
            sessionPath,
        });
        expect(request?.messages).toEqual([{
            role: "user",
            content: [{ type: "text", text: "Trace the request path" }],
        }]);
        expect(request?.tools?.map((tool) => tool.name)).not.toContain(
            "subagent",
        );
        expect((await SessionStore.open(sessionPath)).messages()).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "Trace the request path" }],
            },
            response,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("aborting the parent signal cancels the child turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-"));
    const sessionPath = join(root, "aborted-child.jsonl");
    const controller = new AbortController();
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "this should not finish" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response], { chunkSize: 1, delayMs: 20 });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const adapter: ModelAdapter = {
        stream(request) {
            markStarted?.();
            return faux.stream(request);
        },
    };

    try {
        const child = runSubagent({
            adapter,
            model: "test",
            description: "Work until cancelled",
            workspace: root,
            approvalMode: "approve_for_me",
            sessionId: "child-abort",
            sessionPath,
            signal: controller.signal,
        });
        await started;
        controller.abort(new Error("Parent turn aborted"));

        await expect(child).rejects.toThrow("Parent turn aborted");
        const messages = (await SessionStore.open(sessionPath)).messages();
        expect(messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "aborted",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
