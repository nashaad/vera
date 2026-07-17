import { expect, test } from "bun:test";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
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
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

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
    };

    channel.client.send({ type: "prompt", content: "run ls" });
    const turn = runTurn(adapter, "test", state);

    expect(await channel.client.receive()).toEqual({
        type: "tool_started",
        tool: "bash",
        args: { command: "ls" },
        seq: 1,
    });
    expect(await channel.client.receive()).toEqual({
        type: "tool_finished",
        tool: "bash",
        seq: 2,
    });
    expect(await channel.client.receive()).toEqual({
        type: "assistant_delta",
        text: "done",
        seq: 3,
    });
    expect(await channel.client.receive()).toEqual({
        type: "turn_finished",
        seq: 4,
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
