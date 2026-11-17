import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel, type MessageChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import type { EngineCommand } from "../../src/engine/timeline-control.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelInputMessage,
    type ModelMessage,
} from "../../src/model/types.ts";
import {
    openSessionAppendFile,
    SessionStore,
    type OpenSessionAppendFile,
    type PendingDelivery,
} from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => { resolve = finish; });
    return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
        await Bun.sleep(5);
    }
}

function toolResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id: "gate-call", name: "test_gate", input: {} }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

interface CapturedRequest {
    readonly turnId: string | undefined;
    readonly messages: readonly ModelInputMessage[];
}

async function setup(options: {
    readonly openAppendFile?: OpenSessionAppendFile;
    readonly haltCheck?: () => string | undefined;
    readonly gateFollowup?: boolean;
} = {}) {
    const root = await mkdtemp(join(tmpdir(), "vera-active-deliveries-"));
    temporaryDirectories.push(root);
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "parent",
        cwd: root,
        ...(options.openAppendFile === undefined ? {} : { openAppendFile: options.openAppendFile }),
    });
    const transport = createInProcessChannel();
    const channel = {
        sideA: transport.client as MessageChannel<EngineCommand, AgentUpdate>,
        sideB: transport.engine as MessageChannel<AgentUpdate, EngineCommand>,
    };
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    const discarded: string[] = [];
    events.subscribe((event) => observed.push(event));
    const inbound = new InboundCommandRouter(channel.sideB, events, {
        appendQueuedPrompt: (id, prompt) => store.appendQueuedPrompt(id, { content: prompt.content }),
        removeQueuedPrompt: (id) => store.removeQueuedPrompt(id),
        hasPendingDeliveryTurn: () => store.pendingDeliveries().length > 0
            || store.hasUnansweredDeliveryTurn(),
        onDeliveryTurnDiscarded: (reason) => discarded.push(reason),
    });
    const started = deferred<AbortSignal>();
    const release = deferred<void>();
    const followupStarted = deferred<AbortSignal | undefined>();
    const releaseFollowup = deferred<void>();
    const tool: RegisteredTool = {
        definition: {
            name: "test_gate",
            description: "Wait until released.",
            inputSchema: { type: "object", properties: {} },
        },
        execute: async (_input, _runtime, signal) => {
            started.resolve(signal);
            await release.promise;
            return { kind: "output", output: "Gate released", isError: false };
        },
    };
    const state: RunTurnState = {
        sessionId: "parent",
        messages: [],
        store,
        deliveryInbox: store,
        toolRuntime: new ToolRuntime(root),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        reviewToolCall: async () => ({
            decision: "allow", reason: "Allowed for the test", riskLevel: "low", userAuthorization: "unknown",
        }),
        extensionTools: [tool],
        loadOptionalContext: false,
        ...(options.haltCheck === undefined ? {} : { haltCheck: options.haltCheck }),
    };
    const faux = new FauxAdapter([toolResponse(), textResponse("Current turn finished"), textResponse("Next turn finished")]);
    const requests: CapturedRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push({ turnId: request.turnId, messages: structuredClone(request.messages) });
            if (options.gateFollowup === true && requests.length === 2) {
                const stream = new ModelEventStream();
                followupStarted.resolve(request.signal);
                void (async () => {
                    await releaseFollowup.promise;
                    for await (const event of faux.stream(request)) stream.push(event);
                })();
                return stream;
            }
            return faux.stream(request);
        },
    };
    return {
        path, store, channel, state, adapter, requests, observed, discarded, started, release,
        followupStarted, releaseFollowup,
        async close() {
            release.resolve();
            releaseFollowup.resolve();
            await inbound.stopReceivingCommands();
            await state.toolRuntime.close();
        },
    };
}

function delivery(id: string, extra: Partial<PendingDelivery> = {}): PendingDelivery {
    return { id, sourceAgentId: id, content: `${id} summary`, ...extra };
}

function deliveryIds(messages: readonly (ModelMessage | ModelInputMessage)[]): string[] {
    return messages.flatMap((message) => {
        if (message.role !== "user" || message.internal !== true) return [];
        const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
        const id = /<delivery_id>([^<]+)<\/delivery_id>/.exec(text)?.[1];
        return id === undefined ? [] : [id];
    });
}

function savedDeliveryIds(store: SessionStore): string[] {
    return store.activeEntries().flatMap((entry) =>
        (entry.type === "message" || entry.type === "turn_start") && entry.deliveryId !== undefined
            ? [entry.deliveryId]
            : []
    );
}

test("@core active child completions join the next request once and discard the stale wake", async () => {
    const rig = await setup({ gateFollowup: true });
    try {
        rig.channel.sideA.send({ type: "prompt", content: "Start work" });
        const firstTurn = runTurn(rig.adapter, "test", rig.state);
        const signal = await rig.started.promise;
        await rig.store.recordDelivery(delivery("child-one"));
        await rig.store.recordDelivery(delivery("child-two", { kind: "completion" }));
        rig.channel.sideA.send({ type: "prompt", content: "Also check the rigging" });
        await waitFor(() => rig.observed.some((event) => event.type === "prompt_queued"));
        rig.channel.sideA.send({ type: "trigger_delivery_turn" });
        expect(signal.aborted).toBe(false);
        expect(rig.requests).toHaveLength(1);
        rig.release.resolve();
        await rig.followupStarted.promise;
        const duringRequest = await SessionStore.open(rig.path);
        expect(duringRequest.pendingDeliveries()).toEqual([]);
        expect(duringRequest.hasUnansweredDeliveryTurn()).toBe(true);
        expect(savedDeliveryIds(duringRequest)).toEqual(["child-one", "child-two"]);
        rig.releaseFollowup.resolve();
        await firstTurn;

        expect(rig.requests).toHaveLength(2);
        expect(rig.requests[1]!.turnId).toBe(rig.requests[0]!.turnId);
        expect(rig.requests[1]!.messages.slice(0, rig.requests[0]!.messages.length))
            .toEqual([...rig.requests[0]!.messages]);
        expect(deliveryIds(rig.requests[0]!.messages)).toEqual([]);
        expect(deliveryIds(rig.requests[1]!.messages)).toEqual(["child-one", "child-two"]);
        const messages = rig.requests[1]!.messages;
        const toolResultIndex = messages.findIndex((message) => message.role === "tool_result");
        const joinedIndex = messages.findIndex((message) => message.role === "user"
            && message.content.some((block) => block.type === "text" && block.text.includes("Also check the rigging")));
        const firstDeliveryIndex = messages.findIndex((message) => deliveryIds([message]).length > 0);
        expect(toolResultIndex).toBeGreaterThan(-1);
        expect(joinedIndex).toBeGreaterThan(toolResultIndex);
        expect(firstDeliveryIndex).toBeGreaterThan(joinedIndex);
        expect(rig.store.pendingDeliveries()).toEqual([]);
        expect(savedDeliveryIds(rig.store)).toEqual(["child-one", "child-two"]);
        expect(savedDeliveryIds(await SessionStore.open(rig.path))).toEqual(["child-one", "child-two"]);

        const nextTurn = runTurn(rig.adapter, "test", rig.state);
        await waitFor(() => rig.discarded.includes("empty"));
        expect(rig.requests).toHaveLength(2);
        rig.channel.sideA.send({ type: "prompt", content: "Continue" });
        await nextTurn;
        expect(rig.requests).toHaveLength(3);
        expect(rig.requests[2]!.turnId).not.toBe(rig.requests[1]!.turnId);
        expect(deliveryIds(rig.requests[2]!.messages)).toEqual(["child-one", "child-two"]);
        expect(rig.observed.filter((event) => event.type === "turn_finished")).toHaveLength(2);
    } finally {
        await rig.close();
    }
});

test("a completion during a provider request does not interrupt it and wakes the idle parent", async () => {
    const rig = await setup({ gateFollowup: true });
    try {
        rig.channel.sideA.send({ type: "prompt", content: "Start work" });
        const firstTurn = runTurn(rig.adapter, "test", rig.state);
        await rig.started.promise;
        rig.release.resolve();
        const signal = await rig.followupStarted.promise;
        await rig.store.recordDelivery(delivery("child"));
        rig.channel.sideA.send({ type: "trigger_delivery_turn" });
        expect(signal?.aborted).toBe(false);
        expect(rig.requests).toHaveLength(2);
        rig.releaseFollowup.resolve();
        await firstTurn;
        expect(deliveryIds(rig.requests[1]!.messages)).toEqual([]);
        expect(rig.store.pendingDeliveries().map((entry) => entry.id)).toEqual(["child"]);

        await runTurn(rig.adapter, "test", rig.state);
        expect(rig.requests).toHaveLength(3);
        expect(rig.requests[2]!.turnId).not.toBe(rig.requests[1]!.turnId);
        expect(deliveryIds(rig.requests[2]!.messages)).toEqual(["child"]);
        expect(savedDeliveryIds(await SessionStore.open(rig.path))).toEqual(["child"]);
    } finally {
        await rig.close();
    }
});

test("@core active admission leaves attention, peer, and extension deliveries for the next turn", async () => {
    const rig = await setup();
    try {
        rig.channel.sideA.send({ type: "prompt", content: "Start work" });
        const firstTurn = runTurn(rig.adapter, "test", rig.state);
        await rig.started.promise;
        const entries = [
            delivery("attention", { kind: "attention" }),
            delivery("child", { kind: "completion" }),
            delivery("peer", { kind: "peer", peer: { fromLabel: "Crow", messageId: 1 } }),
            delivery("extension-attention", { kind: "attention", sourceKind: "extension" }),
            delivery("extension-completion", { kind: "completion", sourceKind: "extension" }),
            delivery("extension-default", { sourceKind: "extension" }),
        ];
        for (const entry of entries) await rig.store.recordDelivery(entry);
        rig.channel.sideA.send({ type: "trigger_delivery_turn" });
        rig.release.resolve();
        await firstTurn;
        expect(deliveryIds(rig.requests[1]!.messages)).toEqual(["child"]);
        expect(rig.store.pendingDeliveries().map((entry) => entry.id)).toEqual([
            "attention", "peer", "extension-attention", "extension-completion", "extension-default",
        ]);
        const reopened = await SessionStore.open(rig.path);
        expect(reopened.pendingDeliveries().map((entry) => entry.id)).toEqual([
            "attention", "peer", "extension-attention", "extension-completion", "extension-default",
        ]);

        await runTurn(rig.adapter, "test", rig.state);
        expect(rig.requests[2]!.turnId).not.toBe(rig.requests[1]!.turnId);
        expect(deliveryIds(rig.requests[2]!.messages)).toEqual([
            "child", "attention", "peer", "extension-attention", "extension-completion", "extension-default",
        ]);
        expect(rig.store.pendingDeliveries()).toEqual([]);
        expect(savedDeliveryIds(await SessionStore.open(rig.path))).toEqual([
            "child", "attention", "peer", "extension-attention", "extension-completion", "extension-default",
        ]);
    } finally {
        await rig.close();
    }
});

for (const mode of ["abort", "halt"] as const) {
    test(`a ${mode} during a tool leaves the completion pending for a later turn`, async () => {
        let halted = false;
        const rig = await setup({ haltCheck: () => halted ? "Stopped" : undefined });
        try {
            rig.channel.sideA.send({ type: "prompt", content: "Start work" });
            const firstTurn = runTurn(rig.adapter, "test", rig.state);
            const signal = await rig.started.promise;
            await rig.store.recordDelivery(delivery("child"));
            if (mode === "abort") {
                rig.channel.sideA.send({ type: "abort" });
                await waitFor(() => signal.aborted);
            } else {
                halted = true;
            }
            rig.release.resolve();
            await firstTurn;
            expect(rig.requests).toHaveLength(mode === "abort" ? 2 : 1);
            expect(rig.requests.flatMap((request) => deliveryIds(request.messages))).toEqual([]);
            expect(rig.store.pendingDeliveries().map((entry) => entry.id)).toEqual(["child"]);
            expect((await SessionStore.open(rig.path)).pendingDeliveries().map((entry) => entry.id)).toEqual(["child"]);
            halted = false;
            rig.channel.sideA.send({ type: "prompt", content: "Resume" });
            await runTurn(rig.adapter, "test", rig.state);
            expect(deliveryIds(rig.requests.at(-1)!.messages)).toEqual(["child"]);
            expect(savedDeliveryIds(await SessionStore.open(rig.path))).toEqual(["child"]);
        } finally {
            await rig.close();
        }
    });
}

test("a partial delivery append failure preserves earlier commits and retries the remainder", async () => {
    let failDelivery = false;
    const openAppendFile: OpenSessionAppendFile = async (path) => {
        const file = await openSessionAppendFile(path);
        return {
            stat: () => file.stat(),
            truncate: (length) => file.truncate(length),
            sync: () => file.sync(),
            close: () => file.close(),
            append: async (bytes) => {
                const record = JSON.parse(new TextDecoder().decode(bytes));
                if (failDelivery && record.deliveryId === "child-two") {
                    failDelivery = false;
                    await file.append(bytes.subarray(0, 12));
                    throw new Error("delivery write failed");
                }
                await file.append(bytes);
            },
        };
    };
    const rig = await setup({ openAppendFile });
    try {
        rig.channel.sideA.send({ type: "prompt", content: "Start work" });
        const firstTurn = runTurn(rig.adapter, "test", rig.state);
        await rig.started.promise;
        await rig.store.recordDelivery(delivery("child-one"));
        await rig.store.recordDelivery(delivery("child-two"));
        failDelivery = true;
        rig.release.resolve();
        await expect(firstTurn).rejects.toThrow("delivery write failed");
        expect(rig.requests).toHaveLength(1);
        expect(deliveryIds(rig.state.messages)).toEqual(["child-one"]);
        expect(rig.store.pendingDeliveries().map((entry) => entry.id)).toEqual(["child-two"]);
        const reopened = await SessionStore.open(rig.path);
        expect(savedDeliveryIds(reopened)).toEqual(["child-one"]);
        expect(reopened.pendingDeliveries().map((entry) => entry.id)).toEqual(["child-two"]);

        rig.channel.sideA.send({ type: "prompt", content: "Retry" });
        await runTurn(rig.adapter, "test", rig.state);
        expect(deliveryIds(rig.requests[1]!.messages)).toEqual(["child-one", "child-two"]);
        expect(savedDeliveryIds(await SessionStore.open(rig.path))).toEqual(["child-one", "child-two"]);
    } finally {
        await rig.close();
    }
});
