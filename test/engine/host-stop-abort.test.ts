import { expect, test } from "bun:test";
import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter, TurnHaltedError } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";

test("an active turn keeps the stop cause when automatic compaction is running", async () => {
    const channel = createInProcessChannel();
    const router = new InboundCommandRouter(channel.engine, new EngineEventBus());
    const waiting = router.startTurn();
    channel.client.send({ type: "prompt", content: "first" });
    const turn = await waiting;
    const compaction = new AbortController();
    router.beginAutomaticCompaction(compaction);
    const reason = new TurnHaltedError("Turn aborted", "host_stopped_unexpectedly");
    try {
        router.abortActiveTurn(reason);
        expect(compaction.signal.aborted).toBe(true);
        expect(turn.signal.aborted).toBe(true);
        expect(turn.signal.reason).toBe(reason);
    } finally {
        router.endAutomaticCompaction(compaction);
        router.finishTurn();
        await router.stopReceivingCommands();
    }
});
