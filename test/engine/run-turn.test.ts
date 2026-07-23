import { afterAll, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import {
    EngineEventBus,
    createJsonlEventLogger,
    type EngineEvent,
} from "../../src/engine/events.ts";
import {
    createProtocolEncoder,
    type AgentUpdateSender,
} from "../../src/engine/protocol.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelMessage,
    type ModelRequest,
    type ModelReasoningEffort,
} from "../../src/model/types.ts";
import {
    createInProcessChannel,
    type InProcessChannel,
} from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    DEFAULT_MODEL_MAX_TOKENS,
    ESCALATED_MODEL_MAX_TOKENS,
    LENGTH_CONTINUATION_PROMPT,
} from "../../src/engine/recovery.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";
import type { SessionMessageStore } from "../../src/store/session-store.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";

const temporaryWorkspaces: string[] = [];

afterAll(() => {
    for (const workspace of temporaryWorkspaces) {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("one prompt streams assistant text and finishes the turn", async () => {
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response], { chunkSize: 2 });
    let capturedRequest: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(request) {
            capturedRequest = request;
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    };

    channel.client.send({ type: "prompt", content: "say hi" });
    const turn = runTurn(adapter, "test", state, "high");
    await expectUserPrompt(channel, "say hi", 1);

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "he",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "ll",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "o",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 5,
    });
    expect(await turn).toEqual(response);
    expect(capturedRequest?.reasoningEffort).toBe("high");
    expect(capturedRequest?.systemPrompt).toContain("## Identity\n");
    expect(capturedRequest?.systemPrompt).toContain("## Tools\n");
    expect(capturedRequest?.systemPrompt).toContain("- bash: ");
    expect(capturedRequest?.systemPrompt).toContain("- read: ");
    expect(capturedRequest?.systemPrompt).toContain("- write: ");
    expect(capturedRequest?.systemPrompt).toContain("- edit: ");
    expect(capturedRequest?.systemPrompt).toContain(
        `## Workspace\nWorking directory: ${process.cwd()}`,
    );
    expect(capturedRequest?.systemPrompt).toMatch(
        /## Date\nCurrent date: \d{4}-\d{2}-\d{2}/,
    );
    expect(state.messages).toEqual([
        {
            role: "user",
            content: [{ type: "text", text: "say hi" }],
        },
        response,
    ]);
});

test("a thinking-only stop becomes a visible durable model error", async () => {
    const response: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "thinking",
            text: "<tool_calls>not a structured call</tool_calls>",
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    };

    channel.client.send({ type: "prompt", content: "read the note" });
    const result = runTurn(new FauxAdapter([response]), "test", state);
    await expectUserPrompt(channel, "read the note", 1);
    expect(await channel.client.receive()).toMatchObject({
        type: "turn_finished",
        outcome: "error",
        error: "Model returned no visible response or structured tool call.",
    });

    await expect(result).resolves.toMatchObject({
        stopReason: "error",
        errorMessage: "Model returned no visible response or structured tool call.",
    });
    expect(state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "error",
        errorMessage: "Model returned no visible response or structured tool call.",
    });
});

test("image references are durable while model requests receive verified bytes", async () => {
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "I see it" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    let capturedRequest: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(request) {
            capturedRequest = request;
            return new FauxAdapter([response]).stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        readImageContent: async (attachmentId) => {
            expect(attachmentId).toBe("image-1.png");
            return {
                type: "image",
                mediaType: "image/png",
                data: Uint8Array.from([1, 2, 3]),
            };
        },
    };

    channel.client.send({
        type: "prompt",
        content: "inspect this",
        attachmentIds: ["image-1.png"],
    });
    await runTurn(adapter, "test", state);

    expect(state.messages[0]).toEqual({
        role: "user",
        content: [
            { type: "text", text: "inspect this" },
            { type: "image_attachment", attachmentId: "image-1.png" },
        ],
    });
    expect(capturedRequest?.messages[0]).toEqual({
        role: "user",
        content: [
            { type: "text", text: "inspect this" },
            {
                type: "image",
                mediaType: "image/png",
                data: Uint8Array.from([1, 2, 3]),
            },
        ],
    });
});

test("an unreadable image rejects the prompt before persistence or provider use", async () => {
    let providerCalls = 0;
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const adapter: ModelAdapter = {
        stream(request) {
            providerCalls += 1;
            return new FauxAdapter([response]).stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        readImageContent: async () => {
            throw new Error("stored bytes failed verification");
        },
    };

    channel.client.send({
        type: "prompt",
        content: "inspect this",
        attachmentIds: ["bad.png"],
    });
    const result = await runTurn(adapter, "test", state);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stored bytes failed verification");
    expect(state.messages).toEqual([]);
    expect(providerCalls).toBe(0);
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        outcome: "error",
        error: "Image attachment unavailable: stored bytes failed verification",
        seq: 1,
    });

    channel.client.send({ type: "prompt", content: "continue without it" });
    await runTurn(adapter, "test", state);
    expect(providerCalls).toBe(1);
    expect(state.messages).toEqual([
        {
            role: "user",
            content: [{ type: "text", text: "continue without it" }],
        },
        response,
    ]);
});

test("model settings are snapshotted once when each turn starts", async () => {
    const responses: AssistantMessage[] = [
        {
            role: "assistant",
            content: [{ type: "text", text: "continuing" }],
            source: { provider: "faux", api: "scripted", model: "first-model" },
            usage: emptyUsage(),
            stopReason: "length",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "first" }],
            source: { provider: "faux", api: "scripted", model: "first-model" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "second" }],
            source: { provider: "faux", api: "scripted", model: "second-model" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ];
    const faux = new FauxAdapter(responses, { chunkSize: 1, delayMs: 10 });
    const requests: ModelRequest[] = [];
    let signalRequestStarted: () => void = () => {};
    let requestStarted = new Promise<void>((resolve) => {
        signalRequestStarted = resolve;
    });
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            signalRequestStarted();
            return faux.stream(request);
        },
    };
    let settings: {
        readonly model: string;
        readonly reasoningEffort?: ModelReasoningEffort;
    } = {
        model: "first-model",
        reasoningEffort: "low",
    };
    let settingsReadCount = 0;
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState & {
        readonly readModelSettings: () => typeof settings;
    } = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        readModelSettings: () => {
            settingsReadCount += 1;
            return settings;
        },
    };

    channel.client.send({ type: "prompt", content: "first turn" });
    const firstTurn = runTurn(
        adapter,
        "startup-model",
        state,
        "off",
    );
    await expectUserPrompt(channel, "first turn", 1);
    await requestStarted;

    settings = {
        model: "second-model",
        reasoningEffort: "high",
    };
    expect(requests[0]?.model).toBe("first-model");
    expect(requests[0]?.reasoningEffort).toBe("low");
    await receiveThroughTurnFinished(channel);
    await firstTurn;
    expect(requests[1]?.model).toBe("first-model");
    expect(requests[1]?.reasoningEffort).toBe("low");
    expect(settingsReadCount).toBe(1);

    requestStarted = new Promise<void>((resolve) => {
        signalRequestStarted = resolve;
    });
    channel.client.send({ type: "prompt", content: "second turn" });
    const secondTurn = runTurn(
        adapter,
        "startup-model",
        state,
        "off",
    );
    expect(await channel.client.receive()).toMatchObject({
        type: "user_prompt",
        content: "second turn",
    });
    await requestStarted;

    expect(requests[2]?.model).toBe("second-model");
    expect(requests[2]?.reasoningEffort).toBe("high");
    expect(settingsReadCount).toBe(2);
    await receiveThroughTurnFinished(channel);
    await secondTurn;
});

test("permission mode is fixed for one turn and changes on the next", async () => {
    const toolResponse = (id: string): AssistantMessage => ({
        role: "assistant",
        content: [{
            type: "tool_call",
            id,
            name: "bash",
            input: { command: "date" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    });
    const finalResponse = (text: string): AssistantMessage => ({
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    const responses = [
        toolResponse("first-bash"),
        finalResponse("first done"),
        toolResponse("second-bash"),
        finalResponse("second done"),
    ];
    let mode: ApprovalMode = "ask";
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events, {
            readApprovalMode: () => mode,
        }),
        events,
        hooks: new ToolHooks(),
        approvalMode: "ask",
    };
    const adapter = new FauxAdapter(responses);

    channel.client.send({ type: "prompt", content: "first turn" });
    const firstTurn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "first turn", 1);
    mode = "full_access";

    const approval = await channel.client.receive();
    expect(approval.type).toBe("ui_request");
    if (approval.type !== "ui_request") {
        throw new Error("Expected the first turn to retain ask mode");
    }
    channel.client.send({
        type: "ui_response",
        requestId: approval.requestId,
        response: { type: "tool_approval", decision: "allow_once" },
    });
    await receiveThroughTurnFinished(channel);
    await firstTurn;

    channel.client.send({ type: "prompt", content: "second turn" });
    const secondTurn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "second turn", 8);
    expect(await channel.client.receive()).toMatchObject({
        type: "tool_started",
        tool: "bash",
    });
    await receiveThroughTurnFinished(channel);
    await secondTurn;
});

test("turn finished waits for the assistant message append", async () => {
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "saved" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const order: string[] = [];
    let signalAppendStarted: () => void = () => {};
    let releaseAppend: () => void = () => {};
    const appendStarted = new Promise<void>((resolve) => {
        signalAppendStarted = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
        releaseAppend = resolve;
    });
    const store: SessionMessageStore = {
        async appendMessage(message): Promise<void> {
            order.push(`append_started:${message.role}`);
            if (message.role === "assistant") {
                signalAppendStarted();
                await appendReleased;
            }
            order.push(`append_finished:${message.role}`);
        },
    };
    events.subscribe((event) => {
        if (event.type === "turn_finished") {
            order.push("turn_finished");
        }
    });
    const state: RunTurnState = {
        messages: [],
        store,
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    };

    channel.client.send({ type: "prompt", content: "persist this" });
    const turn = runTurn(new FauxAdapter([response]), "test", state);
    await expectUserPrompt(channel, "persist this", 1);

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "saved",
        seq: 2,
    });
    await appendStarted;
    expect(order).toEqual([
        "append_started:user",
        "append_finished:user",
        "append_started:assistant",
    ]);

    releaseAppend();
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 3,
    });
    expect(await turn).toEqual(response);
    expect(order).toEqual([
        "append_started:user",
        "append_finished:user",
        "append_started:assistant",
        "append_finished:assistant",
        "turn_finished",
    ]);
});

test("a length stop preserves streamed text and continues with a larger cap", async () => {
    const partialResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "first half" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "length",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "second half" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([partialResponse, finalResponse]);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const observed: EngineEvent[] = [];
    events.subscribe((event) => observed.push(event));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    };

    channel.client.send({ type: "prompt", content: "write a long answer" });
    const turn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "write a long answer", 1);

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "first half",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "second half",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 4,
    });
    expect(await turn).toEqual(finalResponse);
    expect(requests.map((request) => request.maxTokens)).toEqual([
        DEFAULT_MODEL_MAX_TOKENS,
        ESCALATED_MODEL_MAX_TOKENS,
    ]);
    expect(requests[1]?.messages).toEqual([
        {
            role: "user",
            content: [{ type: "text", text: "write a long answer" }],
        },
        partialResponse,
        {
            role: "user",
            content: [{ type: "text", text: LENGTH_CONTINUATION_PROMPT }],
            internal: true,
        },
    ]);
    expect(state.messages).toEqual([
        ...requests[1]!.messages as readonly ModelMessage[],
        finalResponse,
    ]);
    expect(observed).toContainEqual({
        type: "model_length_continuation",
        model: "test",
        previousMaxTokens: DEFAULT_MODEL_MAX_TOKENS,
        nextMaxTokens: ESCALATED_MODEL_MAX_TOKENS,
        continuation: 1,
        maxContinuations: 3,
    });
});

test("a transient model failure retries only in the engine event log", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-recovery-"));
    temporaryWorkspaces.push(workspace);
    const logPath = join(workspace, "events.jsonl");
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const success = new FauxAdapter([response]);
    let attempts = 0;
    const adapter: ModelAdapter = {
        stream(request): ModelEventStream {
            attempts += 1;
            if (attempts > 1) {
                return success.stream(request);
            }
            const stream = new ModelEventStream();
            const failure: ProviderFailure = {
                kind: "connection",
                resolution: "retry",
                message: "temporary disconnect",
            };
            const error = new ProviderFailureError(
                failure,
                new Error(failure.message),
            );
            stream.push({ type: "start" });
            stream.push({
                type: "error",
                error,
                message: {
                    ...response,
                    content: [],
                    stopReason: "error",
                    errorMessage: error.message,
                },
            });
            return stream;
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    events.subscribe(createJsonlEventLogger({
        path: logPath,
        sessionId: "recovery-test",
    }));
    const delays: number[] = [];
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        waitForModelRetry: async (delayMs) => {
            delays.push(delayMs);
        },
    };

    channel.client.send({ type: "prompt", content: "recover" });
    const turn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "recover", 1);

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "recovered",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 3,
    });
    expect(await turn).toEqual(response);
    expect(attempts).toBe(2);
    expect(delays).toEqual([500]);

    const logged = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({
        type: "model_retry_scheduled",
        model: "test",
        nextAttempt: 2,
        delayMs: 500,
        failure: expect.objectContaining({
            kind: "connection",
            resolution: "retry",
        }),
    }));
});

test("model fallback stays selected through the tool loop", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-fallback-"));
    temporaryWorkspaces.push(workspace);
    const logPath = join(workspace, "events.jsonl");
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "fallback_call",
            name: "write",
            input: { path: "fallback.txt", content: "used backup" },
        }],
        source: { provider: "faux", api: "scripted", model: "backup" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "finished on backup" }],
        source: { provider: "faux", api: "scripted", model: "backup" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const nextTurnResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "primary again" }],
        source: { provider: "faux", api: "scripted", model: "primary" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const success = new FauxAdapter([
        toolCallResponse,
        finalResponse,
        nextTurnResponse,
    ]);
    const models: string[] = [];
    const adapter: ModelAdapter = {
        stream(request): ModelEventStream {
            models.push(request.model);
            if (models.length > 1) {
                return success.stream(request);
            }
            const stream = new ModelEventStream();
            const failure: ProviderFailure = {
                kind: "server",
                resolution: "retry",
                message: "primary overloaded",
            };
            const error = new ProviderFailureError(
                failure,
                new Error(failure.message),
            );
            stream.push({ type: "start" });
            stream.push({
                type: "error",
                error,
                message: {
                    ...toolCallResponse,
                    content: [],
                    source: {
                        provider: "faux",
                        api: "scripted",
                        model: "primary",
                    },
                    stopReason: "error",
                    errorMessage: error.message,
                },
            });
            return stream;
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    events.subscribe(createJsonlEventLogger({
        path: logPath,
        sessionId: "fallback-test",
    }));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        modelFallback: { model: "backup", afterFailures: 1 },
    };

    channel.client.send({ type: "prompt", content: "use fallback" });
    const turn = runTurn(adapter, "primary", state);
    await expectUserPrompt(channel, "use fallback", 1);

    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "write",
        args: { path: "fallback.txt", content: "used backup" },
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "write",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "finished on backup",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 5,
    });
    expect(await turn).toEqual(finalResponse);
    expect(models).toEqual(["primary", "backup", "backup"]);
    expect(readFileSync(join(workspace, "fallback.txt"), "utf8"))
        .toBe("used backup");

    channel.client.send({ type: "prompt", content: "new turn" });
    const nextTurn = runTurn(adapter, "primary", state);
    await expectUserPrompt(channel, "new turn", 6);
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "primary again",
        seq: 7,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 8,
    });
    expect(await nextTurn).toEqual(nextTurnResponse);
    expect(models).toEqual(["primary", "backup", "backup", "primary"]);

    const logged = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({
        type: "model_fallback_selected",
        fromModel: "primary",
        toModel: "backup",
        afterFailures: 1,
        failure: expect.objectContaining({ kind: "server" }),
    }));
    expect(logged
        .filter((event) => event.type === "model_request")
        .map((event) => event.model)).toEqual([
            "primary",
            "backup",
            "primary",
        ]);
});

test("a bash tool call runs and continues the model turn", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_1",
                name: "bash",
                input: { command: "ls" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const adapter = new FauxAdapter([toolCallResponse, finalResponse]);
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const hooks = new ToolHooks();
    let postHookTool: string | undefined;
    hooks.registerPostToolUse((payload) => {
        postHookTool = payload.toolCall.name;
        return { power: "observe" };
    });
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "ask",
    };

    channel.client.send({ type: "prompt", content: "run ls" });
    const turn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "run ls", 1);

    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "bash",
        args: { command: "ls" },
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "done",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 5,
    });
    expect(await turn).toEqual(finalResponse);
    const toolResult = state.messages[2];
    expect(toolResult).toMatchObject({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        isError: false,
    });
    if (toolResult?.role !== "tool_result") {
        throw new Error("Expected a tool result message");
    }
    expect(toolResult.content[0]?.text).toContain("package.json");
    expect(postHookTool).toBe("bash");
});

test("ask_user waits for a semantic choice and returns its stable ID", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_question",
            name: "ask_user",
            input: {
                question: "Which release channel should Vera use?",
                choices: [
                    { id: "stable-channel", label: "Stable" },
                    { id: "preview-channel", label: "Preview" },
                ],
            },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Preview selected" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        enableUserInteraction: true,
    };

    channel.client.send({ type: "prompt", content: "choose a channel" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    await expectUserPrompt(channel, "choose a channel", 1);
    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "ask_user",
        args: toolCallResponse.content[0]?.type === "tool_call"
            ? toolCallResponse.content[0].input
            : {},
        seq: 2,
    });
    const question = await channel.client.receive();
    expect(question).toMatchObject({
        type: "ui_request",
        request: {
            type: "user_question",
            question: "Which release channel should Vera use?",
            choices: [
                { id: "stable-channel", label: "Stable" },
                { id: "preview-channel", label: "Preview" },
            ],
        },
        seq: 3,
    });
    if (question.type !== "ui_request") {
        throw new Error("Expected a user question update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: question.requestId,
        response: {
            type: "user_question",
            outcome: "selected",
            choiceId: "preview-channel",
        },
    });
    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: question.requestId,
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "ask_user",
        seq: 5,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "Preview selected",
        seq: 6,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 7,
    });
    expect(await turn).toEqual(finalResponse);
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        toolCallId: "call_question",
        toolName: "ask_user",
        content: [{
            type: "text",
            text: JSON.stringify({
                choice_id: "preview-channel",
                label: "Preview",
            }),
        }],
        isError: false,
    });
});

test("a failed tool-result append still closes the tool lifecycle", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_read",
                name: "read",
                input: { path: "package.json" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const hooks = new ToolHooks();
    let postHookRan = false;
    hooks.registerPostToolUse(() => {
        postHookRan = true;
        return { power: "observe" };
    });
    const store: SessionMessageStore = {
        async appendMessage(message): Promise<void> {
            if (message.role === "tool_result") {
                throw new Error("disk full");
            }
        },
    };
    const state: RunTurnState = {
        messages: [],
        store,
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "auto",
    };

    channel.client.send({ type: "prompt", content: "read package.json" });
    const turn = runTurn(new FauxAdapter([toolCallResponse]), "test", state);
    await expectUserPrompt(channel, "read package.json", 1);

    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "read",
        args: { path: "package.json" },
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "read",
        seq: 3,
    });
    await expect(turn).rejects.toThrow("disk full");
    expect(postHookRan).toBe(true);
    expect(state.messages).toEqual([
        {
            role: "user",
            content: [{ type: "text", text: "read package.json" }],
        },
        toolCallResponse,
    ]);
});

test("a pre-tool hook can deny execution with a tool result", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_1",
                name: "bash",
                input: { command: "printf ran" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "denied" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => ({
        power: "block",
        reason: "blocked by test",
    }));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "auto",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    await expectUserPrompt(channel, "run it", 1);

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "denied",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 3,
    });
    expect(await turn).toEqual(finalResponse);
    expect(state.messages[2]).toEqual({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "blocked by test" }],
        isError: true,
    });
});

test("a pre-tool mutation becomes the validated and durable tool call", async () => {
    const originalResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "bash",
            input: { command: "printf original" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const requests: ModelRequest[] = [];
    const faux = new FauxAdapter([originalResponse, finalResponse]);
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const observedEvents: EngineEvent[] = [];
    events.subscribe((event) => observedEvents.push(event));
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => ({
        power: "mutate",
        input: { command: "printf changed" },
    }));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "run it", 1);
    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "bash",
        args: { command: "printf changed" },
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "done",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 5,
    });
    await turn;

    expect(state.messages[1]).toMatchObject({
        role: "assistant",
        content: [{
            type: "tool_call",
            input: { command: "printf changed" },
        }],
    });
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        content: [{ type: "text", text: "changed" }],
    });
    expect(requests[1]?.messages[1]).toEqual(state.messages[1]);
    expect(observedEvents).toContainEqual({
        type: "tool_input_changed",
        original: {
            id: "call_1",
            name: "bash",
            input: { command: "printf original" },
        },
        effective: {
            id: "call_1",
            name: "bash",
            input: { command: "printf changed" },
        },
    });
});

test("a pre-tool replacement returns data without executing the tool", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-replace-"));
    temporaryWorkspaces.push(workspace);
    const marker = join(workspace, "should-not-exist");
    const mutatedMarker = join(workspace, "also-should-not-exist");
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "bash",
            input: { command: `touch ${JSON.stringify(marker)}` },
            signature: "signature-for-original-input",
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "synthetic result received" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => ({
        power: "mutate",
        input: { command: `touch ${JSON.stringify(mutatedMarker)}` },
    }));
    hooks.registerPreToolUse(() => ({
        power: "replace",
        result: {
            content: [{ type: "text", text: "synthetic" }],
            isError: false,
        },
    }));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    await expectUserPrompt(channel, "run it", 1);
    expect(await channel.client.receive()).toMatchObject({
        type: "tool_started",
        tool: "bash",
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 3,
    });
    expect(await channel.client.receive()).toMatchObject({
        type: "assistant_delta",
        text: "synthetic result received",
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 5,
    });
    await turn;
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(mutatedMarker)).toBe(false);
    expect(state.messages[1]).toMatchObject({
        role: "assistant",
        content: [{
            type: "tool_call",
            input: { command: `touch ${JSON.stringify(mutatedMarker)}` },
        }],
    });
    if (state.messages[1]?.role !== "assistant") {
        throw new Error("Expected an assistant tool call");
    }
    expect(state.messages[1].content[0]).not.toHaveProperty("signature");
    expect(state.messages[2]).toEqual({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "synthetic" }],
        isError: false,
    });
});

test("hook failures fail closed without breaking durable tool history", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "bash",
            input: { command: "printf should-not-run" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const observedEvents: EngineEvent[] = [];
    events.subscribe((event) => observedEvents.push(event));
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => {
        throw new Error("broken extension");
    });
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    await expectUserPrompt(channel, "run it", 1);
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "continued",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 3,
    });
    await turn;

    expect(state.messages[1]).toEqual(toolCallResponse);
    expect(state.messages[2]).toEqual({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{
            type: "text",
            text: "pre_tool_use hook failed: broken extension",
        }],
        isError: true,
    });
    expect(observedEvents).toContainEqual({
        type: "tool_hook_failed",
        phase: "pre_tool_use",
        toolCall: {
            id: "call_1",
            name: "bash",
            input: { command: "printf should-not-run" },
        },
        error: "broken extension",
    });
});

test("a post-tool hook failure preserves the raw result and continues", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "bash",
            input: { command: "printf raw" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const observedEvents: EngineEvent[] = [];
    events.subscribe((event) => observedEvents.push(event));
    const hooks = new ToolHooks();
    hooks.registerPostToolUse(() => {
        throw new Error("broken observer");
    });
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    await expectUserPrompt(channel, "run it", 1);
    expect(await channel.client.receive()).toMatchObject({ type: "tool_started" });
    expect(await channel.client.receive()).toMatchObject({ type: "tool_finished" });
    expect(await channel.client.receive()).toMatchObject({
        type: "assistant_delta",
        text: "continued",
    });
    expect(await channel.client.receive()).toMatchObject({ type: "turn_finished" });
    await turn;

    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        content: [{ type: "text", text: "raw" }],
        isError: false,
    });
    expect(observedEvents).toContainEqual(expect.objectContaining({
        type: "tool_hook_failed",
        phase: "post_tool_use",
        error: "broken observer",
    }));
});

test("a post-tool mutation becomes the durable model-visible result", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_1",
            name: "bash",
            input: { command: "printf raw" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const requests: ModelRequest[] = [];
    const faux = new FauxAdapter([toolCallResponse, finalResponse]);
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const hooks = new ToolHooks();
    hooks.registerPostToolUse(() => ({
        power: "mutate",
        patch: {
            content: [{ type: "text", text: "redacted" }],
            isError: true,
        },
    }));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "run it", 1);
    expect(await channel.client.receive()).toMatchObject({ type: "tool_started" });
    expect(await channel.client.receive()).toMatchObject({ type: "tool_finished" });
    expect(await channel.client.receive()).toMatchObject({ type: "assistant_delta" });
    expect(await channel.client.receive()).toMatchObject({ type: "turn_finished" });
    await turn;

    expect(state.messages[2]).toEqual({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "redacted" }],
        isError: true,
    });
    expect(requests[1]?.messages[2]).toEqual(state.messages[2]);
});

test("ask mode turns a client denial into a tool result", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_1",
                name: "bash",
                input: { command: "printf should-not-run" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "not run" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "ask",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    await expectUserPrompt(channel, "run it", 1);

    const approvalRequest = await channel.client.receive();
    if (approvalRequest.type !== "ui_request") {
        throw new Error("Expected a UI request update");
    }
    channel.client.send({
        type: "ui_response",
        requestId: approvalRequest.requestId,
        response: { type: "tool_approval", decision: "deny" },
    });

    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: approvalRequest.requestId,
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "not run",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 5,
    });
    expect(await turn).toEqual(finalResponse);
    expect(state.messages[2]).toEqual({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "Tool use was denied by the user." }],
        isError: true,
    });
});

test("full access permits an ordinary recursive deletion after hook mutation", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-permission-"));
    temporaryWorkspaces.push(workspace);
    const protectedDirectory = join(workspace, "protected");
    mkdirSync(protectedDirectory);
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_1",
                name: "bash",
                input: { command: "printf harmless" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "blocked" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const hooks = new ToolHooks();
    hooks.registerPreToolUse(() => ({
        power: "mutate",
        input: {
            command: `rm -rf ${JSON.stringify(protectedDirectory)}`,
        },
    }));
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "remove it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );
    await expectUserPrompt(channel, "remove it", 1);

    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "bash",
        args: { command: `rm -rf ${JSON.stringify(protectedDirectory)}` },
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "blocked",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 5,
    });
    expect(await turn).toEqual(finalResponse);
    expect(existsSync(protectedDirectory)).toBe(false);
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        isError: false,
    });
});

test("aborting a turn stops its foreground bash tool", async () => {
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_1",
                name: "bash",
                input: { command: "sleep 5" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const adapter = new FauxAdapter([toolCallResponse]);
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        reviewToolCall: async () => ({
            decision: "allow",
            reason: "The requested sleep is ordinary.",
            riskLevel: "low",
            userAuthorization: "high",
        }),
    };

    channel.client.send({ type: "prompt", content: "run slowly" });
    const turn = runTurn(adapter, "test", state);
    await expectUserPrompt(channel, "run slowly", 1);

    expect(await channel.client.receive()).toMatchObject({
        type: "tool_review",
        tool: "bash",
        decision: "allow",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "bash",
        args: { command: "sleep 5" },
        seq: 3,
    });
    const abortedAt = performance.now();
    channel.client.send({ type: "abort" });

    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        outcome: "aborted",
        error: "Turn aborted",
        seq: 5,
    });
    expect(performance.now() - abortedAt).toBeLessThan(1_000);

    const result = await turn;
    expect(result.stopReason).toBe("aborted");
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        isError: true,
    });
});

function reviewedTurnState(
    channel: InProcessChannel,
    events: EngineEventBus,
    review: RunTurnState["reviewToolCall"],
): RunTurnState {
    return {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        ...(review === undefined ? {} : { reviewToolCall: review }),
    };
}

function repeatedBoundaryCrossings(count: number): AssistantMessage[] {
    return Array.from({ length: count }, (_unused, index) => ({
        role: "assistant" as const,
        content: [{
            type: "tool_call" as const,
            id: `call_${index + 1}`,
            name: "bash",
            input: { command: "echo $HOME" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use" as const,
    }));
}

function boundaryCrossingResponses(): AssistantMessage[] {
    return [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "call_1",
                name: "bash",
                input: { command: "echo $HOME" },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ];
}

function outsideWriteResponses(path: string): AssistantMessage[] {
    return [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "call_1",
                name: "write",
                input: { path, content: "updated" },
            }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ];
}

test("auto sends a boundary crossing to the reviewer, not the user", async () => {
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const seen: string[] = [];
    const state = reviewedTurnState(channel, events, async (request) => {
        seen.push(String(request.toolCall.input.command));
        return {
            decision: "allow",
            reason: "Reads an environment variable.",
            riskLevel: "low",
            userAuthorization: "unknown",
        };
    });

    channel.client.send({ type: "prompt", content: "go" });
    const turn = runTurn(new FauxAdapter(boundaryCrossingResponses()), "test", state);

    const updates: string[] = [];
    while (true) {
        const update = await channel.client.receive();
        updates.push(update.type);
        if (update.type === "tool_review") {
            expect(update).toMatchObject({
                type: "tool_review",
                tool: "bash",
                decision: "allow",
                reason: "Reads an environment variable.",
                riskLevel: "low",
                userAuthorization: "unknown",
            });
        }
        if (update.type === "turn_finished") {
            break;
        }
    }
    await turn;

    expect(seen).toEqual(["echo $HOME"]);
    expect(updates).toContain("tool_review");
    expect(updates).toContain("tool_started");
    expect(updates).not.toContain("ui_request");
});

test("auto reviews and executes a structured write outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-outside-write-"));
    temporaryWorkspaces.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const reasons: string[] = [];
    const state: RunTurnState = {
        ...reviewedTurnState(channel, events, async (request) => {
            reasons.push(request.reason);
            return {
                decision: "allow",
                reason: "The named note is authorized.",
                riskLevel: "low",
                userAuthorization: "high",
            };
        }),
        toolRuntime: new ToolRuntime(workspace),
    };

    channel.client.send({ type: "prompt", content: "update the note" });
    const turn = runTurn(
        new FauxAdapter(outsideWriteResponses("../outside.txt")),
        "test",
        state,
    );
    await receiveThroughTurnFinished(channel);
    await turn;

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
        `write ${join(realpathSync(root), "outside.txt")}`,
    );
    expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("updated");
});

test("full access executes a structured outside write without review", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-full-outside-write-"));
    temporaryWorkspaces.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        ...reviewedTurnState(channel, events, undefined),
        toolRuntime: new ToolRuntime(workspace),
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "update the note" });
    const turn = runTurn(
        new FauxAdapter(outsideWriteResponses("../outside.txt")),
        "test",
        state,
    );
    const updateTypes: string[] = [];
    while (true) {
        const update = await channel.client.receive();
        updateTypes.push(update.type);
        if (update.type === "turn_finished") {
            break;
        }
    }
    await turn;

    expect(updateTypes).not.toContain("ui_request");
    expect(updateTypes).not.toContain("tool_review");
    expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("updated");
});

test("ask requests approval before a structured outside write", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-ask-outside-write-"));
    temporaryWorkspaces.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state: RunTurnState = {
        ...reviewedTurnState(channel, events, undefined),
        toolRuntime: new ToolRuntime(workspace),
        approvalMode: "ask",
    };

    channel.client.send({ type: "prompt", content: "update the note" });
    const turn = runTurn(
        new FauxAdapter(outsideWriteResponses("../outside.txt")),
        "test",
        state,
    );
    let requestId = "";
    while (true) {
        const update = await channel.client.receive();
        if (update.type === "ui_request") {
            requestId = update.requestId;
            expect(update.request).toMatchObject({
                type: "tool_approval",
                reason: expect.stringContaining(
                    `write ${join(realpathSync(root), "outside.txt")}`,
                ),
            });
            break;
        }
    }
    channel.client.send({
        type: "ui_response",
        requestId,
        response: { type: "tool_approval", decision: "allow_once" },
    });
    await receiveThroughTurnFinished(channel);
    await turn;

    expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("updated");
});

test("a custom permission profile routes to its named reviewer", async () => {
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const seenProfiles: string[] = [];
    const state: RunTurnState = {
        ...reviewedTurnState(channel, events, undefined),
        approvalMode: "unattended",
        permissionProfiles: {
            unattended: {
                name: "unattended",
                rules: [],
                defaultOutcome: "review",
                reviewerProfile: "careful",
            },
        },
        reviewToolCallForProfile: async (profile) => {
            seenProfiles.push(profile);
            return {
                decision: "allow",
                reason: "The action follows from the request.",
                riskLevel: "low",
                userAuthorization: "medium",
            };
        },
    };

    channel.client.send({ type: "prompt", content: "go" });
    const turn = runTurn(
        new FauxAdapter(boundaryCrossingResponses()),
        "test",
        state,
    );
    await receiveThroughTurnFinished(channel);
    await turn;

    expect(seenProfiles).toEqual(["careful"]);
});

test("a reviewer denial goes back to the model, not to the user", async () => {
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state = reviewedTurnState(channel, events, async () => ({
        decision: "deny",
        reason: "Not needed for the task.",
        riskLevel: "medium",
        userAuthorization: "unknown",
    }));

    channel.client.send({ type: "prompt", content: "go" });
    const turn = runTurn(new FauxAdapter(boundaryCrossingResponses()), "test", state);

    const updates: string[] = [];
    while (true) {
        const update = await channel.client.receive();
        updates.push(update.type);
        if (update.type === "turn_finished") {
            break;
        }
    }
    await turn;

    // The whole point of this mode is that the user is not interrupted, so a
    // denial resolves the tool call rather than raising a prompt.
    expect(updates).toContain("tool_review");
    expect(updates).not.toContain("ui_request");
    expect(updates).not.toContain("tool_started");
    const result = state.messages[2];
    expect(result).toMatchObject({
        role: "tool_result",
        toolName: "bash",
        isError: true,
    });
    const text = JSON.stringify(result);
    expect(text).toContain("Not needed for the task.");
    // The agent is told not to route around the denial.
    expect(text).toContain("workaround");
});

test("an unavailable reviewer escalates to the attached user", async () => {
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state = reviewedTurnState(channel, events, async () => ({
        decision: "unavailable",
        reason: "The approval reviewer was unavailable (timed out).",
        riskLevel: "high",
        userAuthorization: "unknown",
    }));

    channel.client.send({ type: "prompt", content: "go" });
    const turn = runTurn(new FauxAdapter(boundaryCrossingResponses()), "test", state);
    let requestId = "";
    while (true) {
        const update = await channel.client.receive();
        if (update.type === "ui_request") {
            requestId = update.requestId;
            expect(update.request).toMatchObject({
                type: "tool_approval",
                reason: expect.stringContaining("timed out"),
            });
            break;
        }
    }
    channel.client.send({
        type: "ui_response",
        requestId,
        response: { type: "tool_approval", decision: "deny" },
    });
    await receiveThroughTurnFinished(channel);
    await turn;

    expect(requestId.length).toBeGreaterThan(0);
    expect(state.messages[2]).toMatchObject({
        role: "tool_result",
        isError: true,
    });
});

test("repeated reviewer denials stop the turn", async () => {
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    let reviews = 0;
    const state = reviewedTurnState(channel, events, async () => {
        reviews += 1;
        return {
            decision: "deny",
            reason: "Writes outside the workspace.",
            riskLevel: "high",
            userAuthorization: "unknown",
        };
    });

    channel.client.send({ type: "prompt", content: "go" });
    const turn = runTurn(
        new FauxAdapter(repeatedBoundaryCrossings(5)),
        "test",
        state,
    );
    await receiveThroughTurnFinished(channel);
    const message = await turn;

    // Three denials in a row is the breaker's limit, so the fourth crossing is
    // never reviewed: the turn stops with the reason instead.
    expect(reviews).toBe(3);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("denied 3 actions in a row");
    // Persisted, not just emitted. A session that ends at the last denied
    // tool result cannot tell anyone why it stopped after a reconnect.
    expect(state.messages.at(-1)).toBe(message);
});

test("auto still asks the user when no reviewer is configured", async () => {
    const channel = createInProcessChannel();
    const events = createTestEvents(channel.engine);
    const state = reviewedTurnState(channel, events, undefined);

    channel.client.send({ type: "prompt", content: "go" });
    const turn = runTurn(new FauxAdapter(boundaryCrossingResponses()), "test", state);

    let requestId = "";
    while (true) {
        const update = await channel.client.receive();
        if (update.type === "ui_request") {
            requestId = update.requestId;
            break;
        }
    }
    channel.client.send({
        type: "ui_response",
        requestId,
        response: { type: "tool_approval", decision: "deny" },
    });
    await receiveThroughTurnFinished(channel);
    await turn;

    expect(requestId.length).toBeGreaterThan(0);
});

function createTestEvents(sender: AgentUpdateSender): EngineEventBus {
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(sender));
    return events;
}

async function expectUserPrompt(
    channel: InProcessChannel,
    content: string,
    seq: number,
): Promise<void> {
    expect(await channel.client.receive()).toEqual({
        type: "user_prompt",
        content,
        seq,
    });
}

async function receiveThroughTurnFinished(
    channel: InProcessChannel,
): Promise<void> {
    while (true) {
        const update = await channel.client.receive();
        if (update.type === "turn_finished") {
            return;
        }
    }
}
