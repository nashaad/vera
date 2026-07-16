import { expect, test } from "bun:test";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { createInProcessChannel } from "../../src/rpc/in-process-channel.ts";
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
    const adapter = new FauxAdapter([response], { chunkSize: 2 });
    const channel = createInProcessChannel();
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(process.cwd()),
        queuedPrompts: [],
        seq: 0,
    };

    channel.client.send({ type: "prompt", content: "say hi" });
    const turn = runTurn(channel.engine, adapter, "test", state);

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
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(process.cwd()),
        queuedPrompts: [],
        seq: 0,
    };

    channel.client.send({ type: "prompt", content: "run ls" });
    const turn = runTurn(channel.engine, adapter, "test", state);

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
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(process.cwd()),
        queuedPrompts: [],
        seq: 0,
    };

    channel.client.send({ type: "prompt", content: "run slowly" });
    const turn = runTurn(channel.engine, adapter, "test", state);

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
