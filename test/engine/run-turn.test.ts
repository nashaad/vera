import { expect, test } from "bun:test";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { createInProcessChannel } from "../../src/rpc/in-process-channel.ts";
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
    const state: RunTurnState = { messages: [], seq: 0 };

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
