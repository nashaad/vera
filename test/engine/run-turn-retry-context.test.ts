import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelRequest } from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { InMemorySessionStore } from "../../test/support/in-memory-session-store.ts";
import { ImageAttachmentService, OMITTED_IMAGE_TEXT, sessionAttachmentSource } from "../../src/attachments/service.ts";
import { createCompactionController } from "../../src/engine/compaction-controller.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("@core a retry after a model switch uses the newly compacted context", async () => {
    const root = mkdtempSync(join(tmpdir(), "lqms-context-check-"));
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const requests: ModelRequest[] = [];
    let settings = { provider: "faux", model: "wide", contextWindow: 100000 };
    let compacted = false;
    const state: RunTurnState = {
        messages: [], store: new InMemorySessionStore(), toolRuntime: new ToolRuntime(root),
        inbound: new InboundCommandRouter(channel.engine, events), events, hooks: new ToolHooks(),
        approvalMode: "auto", loadOptionalContext: false,
        readModelSettings: () => settings,
        waitForModelRetry: async () => {},
        modelContext: () => compacted
            ? [{ role: "user", content: [{ type: "text", text: "compacted context" }] }]
            : state.messages,
        compact: async (_signal, _pending, context) => {
            if (context?.model === "narrow") compacted = true;
        },
    };
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            const stream = new ModelEventStream();
            const message: AssistantMessage = {
                role: "assistant", content: [], source: { provider: "faux", api: "test", model: request.model },
                usage: emptyUsage(), stopReason: "error", errorMessage: "temporary failure",
            };
            if (requests.length === 1) {
                settings = { provider: "faux", model: "narrow", contextWindow: 1000 };
                const failure = { kind: "unknown" as const, resolution: "retry" as const, message: "temporary failure" };
                stream.push({ type: "error", error: new ProviderFailureError(failure, new Error(failure.message)), message });
            } else {
                stream.push({ type: "done", message: { ...message, content: [{ type: "text", text: "done" }], stopReason: "stop" } });
            }
            return stream;
        },
    };
    try {
        channel.client.send({ type: "prompt", content: "original context" });
        await runTurn(adapter, "wide", state);
        expect(compacted).toBe(true);
        expect(requests.map((request) => request.model)).toEqual(["wide", "narrow"]);
        expect(requests[1]?.messages).toContainEqual({ role: "user", content: [{ type: "text", text: "compacted context" }] });
    } finally {
        await state.inbound.stopReceivingCommands();
        await state.toolRuntime.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("a switched retry uses the persisted compaction before its recorded response", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-retry-compaction-"));
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
    const images = new ImageAttachmentService(
        store,
        { maxBytes: 100, maxWidth: 100, maxHeight: 100 },
        async () => ({ mediaType: "image/png", width: 2, height: 3 }),
    );
    const image = await images.attach(Uint8Array.from([1, 2, 3]), "map.png", undefined, "/deck/map.png");
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "old chart ".repeat(10_000) }],
    });
    const oldReply = await store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        source: { provider: "faux", api: "test", model: "wide" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    const joined = await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "watch the cove" }],
        arrivedDuringTurn: true,
    });
    await store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "watching" }],
        source: { provider: "faux", api: "test", model: "wide" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    const summary = {
        role: "user" as const,
        internal: true,
        content: [{ type: "text" as const, text: "compacted chart" }],
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const inbound = new InboundCommandRouter(channel.engine, events);
    const requests: ModelRequest[] = [];
    let settings = { provider: "faux", model: "wide", contextWindow: 100_000 };
    let compactions = 0;
    const controller = createCompactionController({
        store,
        model: "wide",
        scratchDir: root,
        events,
        readCompaction: () => ({
            strategy: {
                id: "test-summary",
                models: [],
                compact: async () => {
                    compactions += 1;
                    return { projection: [summary] };
                },
            },
            models: {},
            retainedUserTurns: 2,
        }),
        readToolResults: () => undefined,
        readModelSettings: () => settings,
        inbound,
        afterCompacted: async () => false,
    });
    const state: RunTurnState = {
        sessionId: "crow",
        messages: [...store.messages()],
        store,
        toolRuntime: new ToolRuntime(root),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        loadOptionalContext: false,
        readImageContent: (id) => images.readContent(id),
        imageSource: sessionAttachmentSource(store),
        readModelSettings: () => settings,
        waitForModelRetry: async () => {},
        contextWatch: controller.contextWatch,
        modelContext: (context) => controller.modelContext(context),
        historyLineage: () => controller.historyLineage(),
        compact: (signal, pending, context, turn) =>
            controller.compact(signal, false, pending, context, turn),
    };
    const adapter: ModelAdapter = {
        supportsImageInputFor: (_provider, model) => model === "wide",
        stream(request) {
            requests.push(request);
            const stream = new ModelEventStream();
            const message: AssistantMessage = {
                role: "assistant",
                content: [],
                source: { provider: "faux", api: "test", model: request.model },
                usage: emptyUsage(),
                stopReason: "error",
                errorMessage: "temporary failure",
            };
            if (requests.length === 1) {
                settings = { provider: "faux", model: "narrow", contextWindow: 20_000 };
                const failure = { kind: "unknown" as const, resolution: "retry" as const, message: "temporary failure" };
                stream.push({ type: "error", error: new ProviderFailureError(failure, new Error(failure.message)), message });
            } else {
                stream.push({
                    type: "done",
                    message: { ...message, content: [{ type: "text", text: "done" }], stopReason: "stop" },
                });
            }
            return stream;
        },
    };
    try {
        channel.client.send({ type: "prompt", content: "inspect the map", attachmentIds: [image.id] });
        await runTurn(adapter, "wide", state);

        const reopened = await SessionStore.open(path);
        const records = readFileSync(path, "utf8").trim().split("\n")
            .map((line) => JSON.parse(line) as { type: string; message?: AssistantMessage });
        const compactionIndex = records.findIndex((record) => record.type === "compaction");
        const responseIndex = records.findIndex((record) =>
            record.type === "message"
            && record.message?.role === "assistant"
            && record.message.source.model === "narrow"
        );
        expect(compactions).toBe(1);
        expect(compactionIndex).toBeGreaterThan(-1);
        expect(responseIndex).toBeGreaterThan(compactionIndex);
        expect(reopened.latestCompaction()).toMatchObject({
            boundaryMessageId: oldReply.id,
            firstRetainedMessageId: joined.id,
            projection: [summary],
        });
        expect(reopened.modelContext()[0]).toEqual(summary);
        expect(reopened.modelContext().at(-1)).toMatchObject({
            role: "assistant", source: { model: "narrow" },
            content: [{ type: "text", text: "done" }],
        });
        expect(requests.map((request) => request.model)).toEqual(["wide", "narrow"]);
        expect(requests[1]!.messages[0]).toEqual(summary);
        expect(requests[1]!.messages.slice(1, -1)).toEqual(requests[0]!.messages.slice(2, -1));
        expect(requests[0]!.messages.at(-1)).toEqual({
            role: "user",
            content: [
                { type: "text", text: "inspect the map" },
                { type: "text", text: "[Image source: /deck/map.png]" },
                { type: "image", mediaType: "image/png", data: Uint8Array.from([1, 2, 3]) },
            ],
        });
        expect(requests[1]!.messages.at(-1)).toEqual({
            role: "user",
            content: [
                { type: "text", text: "inspect the map" },
                { type: "text", text: "[Image source: /deck/map.png]" },
                { type: "text", text: OMITTED_IMAGE_TEXT },
            ],
        });
        const { provider: _p1, model: _m1, reasoningEffort: _e1, messages: _x1, signal: _s1, ...first } = requests[0]!;
        const { provider: _p2, model: _m2, reasoningEffort: _e2, messages: _x2, signal: _s2, ...second } = requests[1]!;
        expect(second).toEqual(first);
    } finally {
        await state.inbound.stopReceivingCommands();
        await state.toolRuntime.close();
        rmSync(root, { recursive: true, force: true });
    }
});

for (const scenario of ["effort-only", "no-compaction"] as const) {
    test(`a retry with ${scenario} ${scenario === "effort-only" ? "keeps" : "refreshes"} its context`, async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-retry-unchanged-"));
        const channel = createInProcessChannel();
        const events = new EngineEventBus();
        const requests: ModelRequest[] = [];
        let settings = { provider: "faux", model: "wide", reasoningEffort: "low" };
        let changed = false;
        const state: RunTurnState = {
            messages: [],
            store: new InMemorySessionStore(),
            toolRuntime: new ToolRuntime(root),
            inbound: new InboundCommandRouter(channel.engine, events),
            events,
            hooks: new ToolHooks(),
            approvalMode: "auto",
            loadOptionalContext: false,
            readModelSettings: () => settings,
            waitForModelRetry: async () => {},
            modelContext: () => changed
                ? [{ role: "user", content: [{ type: "text", text: "later context" }] }]
                : state.messages,
            ...(scenario === "effort-only" ? { compact: async () => {} } : {}),
        };
        const adapter: ModelAdapter = {
            stream(request) {
                requests.push(request);
                const stream = new ModelEventStream();
                const message: AssistantMessage = {
                    role: "assistant",
                    content: [],
                    source: { provider: "faux", api: "test", model: request.model },
                    usage: emptyUsage(),
                    stopReason: "error",
                    errorMessage: "temporary failure",
                };
                if (requests.length === 1) {
                    changed = true;
                    settings = {
                        provider: "faux",
                        model: scenario === "effort-only" ? "wide" : "narrow",
                        reasoningEffort: "high",
                    };
                    const failure = { kind: "unknown" as const, resolution: "retry" as const, message: "temporary failure" };
                    stream.push({ type: "error", error: new ProviderFailureError(failure, new Error(failure.message)), message });
                } else {
                    stream.push({
                        type: "done",
                        message: { ...message, content: [{ type: "text", text: "done" }], stopReason: "stop" },
                    });
                }
                return stream;
            },
        };
        try {
            channel.client.send({ type: "prompt", content: "original context" });
            await runTurn(adapter, "wide", state);
            expect(requests).toHaveLength(2);
            if (scenario === "effort-only") {
                expect(requests[1]!.messages).toEqual(requests[0]!.messages);
            } else {
                expect(requests[1]!.messages).toEqual([
                    { role: "user", content: [{ type: "text", text: "later context" }] },
                ]);
            }
        } finally {
            await state.inbound.stopReceivingCommands();
            await state.toolRuntime.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test("a text-only retry omits images with and without compaction", async () => {
    const scenarios = [
        { provider: "vision", model: "text", compact: false },
        { provider: "text", model: "image", compact: true },
    ];
    const outcomes: Array<{
        requests: ModelRequest[];
        compactCalls: number;
    }> = [];
    for (const scenario of scenarios) {
        const root = mkdtempSync(join(tmpdir(), "vera-retry-text-only-"));
        const channel = createInProcessChannel();
        const events = new EngineEventBus();
        const requests: ModelRequest[] = [];
        let compactCalls = 0;
        let settings = { provider: "vision", model: "image" };
        const state: RunTurnState = {
            messages: [],
            store: new InMemorySessionStore(),
            toolRuntime: new ToolRuntime(root),
            inbound: new InboundCommandRouter(channel.engine, events),
            events,
            hooks: new ToolHooks(),
            approvalMode: "auto",
            loadOptionalContext: false,
            readModelSettings: () => settings,
            waitForModelRetry: async () => {},
            readImageContent: async () => ({
                type: "image", mediaType: "image/png", data: Uint8Array.from([1, 2, 3]),
            }),
            imageSource: () => "/deck/map.png",
            ...(scenario.compact ? { compact: async () => { compactCalls += 1; } } : {}),
        };
        const adapter: ModelAdapter = {
            supportsImageInputFor: (provider, model) => provider === "vision" && model === "image",
            stream(request) {
                requests.push(request);
                const stream = new ModelEventStream();
                const message: AssistantMessage = {
                    role: "assistant",
                    content: [],
                    source: { provider: request.provider ?? "unknown", api: "test", model: request.model },
                    usage: emptyUsage(),
                    stopReason: "error",
                    errorMessage: "temporary failure",
                };
                if (requests.length === 1) {
                    settings = { provider: scenario.provider, model: scenario.model };
                    const failure = { kind: "unknown" as const, resolution: "retry" as const, message: "temporary failure" };
                    stream.push({ type: "error", error: new ProviderFailureError(failure, new Error(failure.message)), message });
                } else {
                    stream.push({
                        type: "done",
                        message: { ...message, content: [{ type: "text", text: "done" }], stopReason: "stop" },
                    });
                }
                return stream;
            },
        };
        try {
            channel.client.send({ type: "prompt", content: "inspect the map", attachmentIds: ["map.png"] });
            await runTurn(adapter, "image", state);
            outcomes.push({ requests, compactCalls });
        } finally {
            await state.inbound.stopReceivingCommands();
            await state.toolRuntime.close();
            rmSync(root, { recursive: true, force: true });
        }
    }

    expect(outcomes.map(({ requests }) => requests.map(({ provider, model }) => ({ provider, model })))).toEqual([
        [{ provider: "vision", model: "image" }, { provider: "vision", model: "text" }],
        [{ provider: "vision", model: "image" }, { provider: "text", model: "image" }],
    ]);
    expect(outcomes.map(({ compactCalls }) => compactCalls)).toEqual([0, 2]);
    for (const { requests } of outcomes) {
        expect(requests[0]!.messages[0]).toMatchObject({
            role: "user",
            content: [{ type: "text" }, { type: "text" }, { type: "image" }],
        });
    }
    expect(outcomes.map(({ requests }) => requests[1]!.messages)).toEqual(scenarios.map(() => [{
        role: "user",
        content: [
            { type: "text", text: "inspect the map" },
            { type: "text", text: "[Image source: /deck/map.png]" },
            { type: "text", text: OMITTED_IMAGE_TEXT },
        ],
    }]));
});
