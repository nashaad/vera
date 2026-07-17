import { afterAll, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import {
    EngineEventBus,
    createJsonlEventLogger,
} from "../../src/engine/events.ts";
import {
    createFrameProjector,
    type AgentFrameSender,
} from "../../src/engine/frames.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { createInProcessChannel } from "../../src/engine/in-process-channel.ts";
import { InboundFrameRouter } from "../../src/engine/inbound-frame-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

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
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundFrameRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
    };

    channel.client.send({ type: "prompt", content: "say hi" });
    const turn = runTurn(adapter, "test", state, "high");

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "he",
        seq: 1,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "ll",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "o",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 4,
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
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundFrameRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
        waitForModelRetry: async (delayMs) => {
            delays.push(delayMs);
        },
    };

    channel.client.send({ type: "prompt", content: "recover" });
    const turn = runTurn(adapter, "test", state);

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "recovered",
        seq: 1,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 2,
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
    });
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundFrameRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "ask",
    };

    channel.client.send({ type: "prompt", content: "run ls" });
    const turn = runTurn(adapter, "test", state);

    const approvalRequest = await channel.client.receive();
    expect(approvalRequest).toMatchObject({
        type: "ui_request",
        request: {
            type: "tool_approval",
            toolCall: {
                id: "call_1",
                name: "bash",
                input: { command: "ls" },
            },
            reason: "Bash commands run with your full user permissions.",
        },
        seq: 1,
    });
    if (approvalRequest.type !== "ui_request") {
        throw new Error("Expected a UI request frame");
    }
    channel.client.send({
        type: "ui_response",
        requestId: approvalRequest.requestId,
        response: { type: "tool_approval", decision: "allow" },
    });

    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: approvalRequest.requestId,
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "bash",
        args: { command: "ls" },
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 4,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "done",
        seq: 5,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 6,
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
        behavior: "deny",
        reason: "blocked by test",
    }));
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundFrameRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "approve_for_me",
    };

    channel.client.send({ type: "prompt", content: "run it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "denied",
        seq: 1,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 2,
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
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundFrameRouter(channel.engine, events),
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

    const approvalRequest = await channel.client.receive();
    if (approvalRequest.type !== "ui_request") {
        throw new Error("Expected a UI request frame");
    }
    channel.client.send({
        type: "ui_response",
        requestId: approvalRequest.requestId,
        response: { type: "tool_approval", decision: "deny" },
    });

    expect(await channel.client.receive()).toEqual({
        type: "ui_request_closed",
        requestId: approvalRequest.requestId,
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "not run",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 4,
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

test("the built-in hard deny blocks a dangerous command in full access", async () => {
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
                input: {
                    command: `rm -rf ${JSON.stringify(protectedDirectory)}`,
                },
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
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundFrameRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "full_access",
    };

    channel.client.send({ type: "prompt", content: "remove it" });
    const turn = runTurn(
        new FauxAdapter([toolCallResponse, finalResponse]),
        "test",
        state,
    );

    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "blocked",
        seq: 1,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 2,
    });
    expect(await turn).toEqual(finalResponse);
    expect(existsSync(protectedDirectory)).toBe(true);
    expect(state.messages[2]).toEqual({
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{
            type: "text",
            text: "Blocked dangerous command: recursive-force rm is not allowed",
        }],
        isError: true,
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
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundFrameRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
    };

    channel.client.send({ type: "prompt", content: "run slowly" });
    const turn = runTurn(adapter, "test", state);

    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "bash",
        args: { command: "sleep 5" },
        seq: 1,
    });
    const abortedAt = performance.now();
    channel.client.send({ type: "abort" });

    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 3,
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

function createTestEvents(sender: AgentFrameSender): EngineEventBus {
    const events = new EngineEventBus();
    events.subscribe(createFrameProjector(sender));
    return events;
}
