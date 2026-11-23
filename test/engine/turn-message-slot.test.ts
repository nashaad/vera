import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import {
    offerTurnMessage,
    recordTurnMessage,
    setTurnMessageAnchorRecorder,
    takeTurnMessage,
} from "../../src/engine/turn-message-slot.ts";

function createRouter(options: ConstructorParameters<typeof InboundCommandRouter>[2] = {}) {
    const channel = createInProcessChannel();
    return {
        channel,
        router: new InboundCommandRouter(channel.engine, new EngineEventBus(), options),
    };
}

test("@core turn messages refuse active offers without a recorder", async () => {
    const { channel, router } = createRouter({
        appendHarnessMessage: async () => {},
    });
    const waiting = router.startTurn();
    channel.client.send({ type: "prompt", content: "start" });
    await waiting;

    expect(offerTurnMessage(router, { text: "exact model text", transcript: "asked" })).toBe(false);
    expect(takeTurnMessage(router)).toBeUndefined();
    await router.finishTurn();
});

test("@core turn message accepts one offer and preserves exact text and transcript", async () => {
    const recorded: { text: string; tone: string }[] = [];
    const { channel, router } = createRouter({
        appendHarnessMessage: async () => {},
    });
    setTurnMessageAnchorRecorder(router, async (text) => {
        recorded.push({ text, tone: "soft" });
    });
    const waiting = router.startTurn();
    channel.client.send({ type: "prompt", content: "start" });
    const turn = await waiting;
    const message = {
        text: "Finish this step.\nNote from the user: leave a summary",
        transcript: "Asked to wrap up.\nNote from the user: leave a summary",
    };

    expect(offerTurnMessage(router, message)).toBe(true);
    expect(offerTurnMessage(router, { text: "replacement", transcript: "replacement" })).toBe(false);
    expect(takeTurnMessage(router)).toEqual(message);
    expect(takeTurnMessage(router)).toBeUndefined();
    await recordTurnMessage(router, message.transcript);
    await router.finishTurn();
    expect(turn.signal.aborted).toBe(false);
    expect(recorded).toEqual([{
        text: message.transcript,
        tone: "soft",
    }]);
});

test("@core turn message slot clears on abort and after turn completion", async () => {
    const { channel, router } = createRouter({
        appendHarnessMessage: async () => {},
    });
    setTurnMessageAnchorRecorder(router, async () => {});
    const waiting = router.startTurn();
    channel.client.send({ type: "prompt", content: "start" });
    const turn = await waiting;

    expect(offerTurnMessage(router, { text: "before abort", transcript: "before abort" })).toBe(true);
    const aborted = new Promise<void>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    channel.client.send({ type: "abort" });
    await aborted;
    expect(turn.signal.aborted).toBe(true);
    expect(takeTurnMessage(router)).toBeUndefined();
    await router.finishTurn("aborted");
    expect(offerTurnMessage(router, { text: "after completion", transcript: "after completion" })).toBe(false);

    const nextWaiting = router.startTurn();
    channel.client.send({ type: "prompt", content: "next" });
    await nextWaiting;
    expect(offerTurnMessage(router, { text: "failed turn", transcript: "failed turn" })).toBe(true);
    await router.finishTurn("failed");
    expect(offerTurnMessage(router, { text: "after failure", transcript: "after failure" })).toBe(false);
});
