import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { parseClientCommand } from "../../src/engine/protocol.ts";

test("a compaction request is decoded, and one without a request id is not", () => {
    expect(parseClientCommand({ type: "compact", requestId: "ask-1" }))
        .toEqual({ type: "compact", requestId: "ask-1" });
    expect(parseClientCommand({ type: "compact" })).toBeUndefined();
    expect(parseClientCommand({ type: "compact", requestId: "" }))
        .toBeUndefined();
});

test("asking to compact between turns runs the compaction", async () => {
    const channel = createInProcessChannel();
    let asked: boolean | undefined;
    const router = new InboundCommandRouter(
        channel.engine,
        new EngineEventBus(),
        { compactNow: async (turnActive) => void (asked = turnActive) },
    );
    void router;

    channel.client.send({ type: "compact", requestId: "ask-1" });
    await settle();

    expect(asked).toBe(false);
});

test("asking during a turn reports the turn, it does not compact under it", async () => {
    // The span compaction replaces has to be finished and durable, so a turn
    // in flight is a reason to say no rather than a reason to wait.
    const channel = createInProcessChannel();
    let asked: boolean | undefined;
    const router = new InboundCommandRouter(
        channel.engine,
        new EngineEventBus(),
        { compactNow: async (turnActive) => void (asked = turnActive) },
    );
    const turn = router.startTurn();
    channel.client.send({ type: "prompt", content: "work" });
    await turn;

    channel.client.send({ type: "compact", requestId: "ask-2" });
    await settle();

    expect(asked).toBe(true);
});

test("a session with no strategy bound ignores the request", async () => {
    const channel = createInProcessChannel();
    const router = new InboundCommandRouter(
        channel.engine,
        new EngineEventBus(),
    );
    void router;

    channel.client.send({ type: "compact", requestId: "ask-3" });
    await settle();
});

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}
