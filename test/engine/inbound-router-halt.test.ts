import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";

const SETTLE_MS = 20;

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function harnessRouter(): {
    readonly router: InboundCommandRouter;
    readonly client: ReturnType<typeof createInProcessChannel>["client"];
    readonly notes: string[];
} {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const notes: string[] = [];
    const router = new InboundCommandRouter(channel.engine, events, {
        appendHarnessMessage: async (text) => {
            notes.push(text);
        },
    });
    return { router, client: channel.client, notes };
}

test("halt drops the queued prompts and writes a Not started line for each", async () => {
    const { router, client, notes } = harnessRouter();
    client.send({ type: "prompt", content: "first" });
    client.send({ type: "prompt", content: "second" });
    await settle();

    router.halt("halted for test");
    await settle();

    expect(notes).toEqual([
        "Not started: halted for test",
        "Not started: halted for test",
    ]);
});

test("a prompt that arrives while halted is dropped and never starts", async () => {
    const { router, client, notes } = harnessRouter();
    router.halt("halted for test");

    client.send({ type: "prompt", content: "during the halt" });
    await settle();

    expect(notes).toEqual(["Not started: halted for test"]);
    let started = false;
    const pending = router.startTurn().then(() => {
        started = true;
    });
    await settle();
    expect(started).toBe(false);
    router.clearHalt();
    client.send({ type: "prompt", content: "after the halt" });
    await pending;
});

test("clearHalt lets the next prompt start, and halt is idempotent until cleared", async () => {
    const { router, client, notes } = harnessRouter();
    router.halt("first reason");
    router.halt("second reason");
    router.clearHalt();

    client.send({ type: "prompt", content: "after clear" });
    const turn = await router.startTurn();

    expect(turn.prompt.content).toBe("after clear");
    expect(notes).toEqual([]);
    router.finishTurn();
});

test("halt aborts the active turn with the reason", async () => {
    const { router, client, notes } = harnessRouter();
    client.send({ type: "prompt", content: "long turn" });
    const turn = await router.startTurn();

    router.halt("halted mid-turn");

    expect(turn.signal.aborted).toBe(true);
    expect(String(turn.signal.reason)).toContain("halted mid-turn");
    expect(notes).toEqual(["Stopped: halted mid-turn"]);
    router.finishTurn("aborted");
});

test("halt denies a pending tool approval with the reason", async () => {
    const { router } = harnessRouter();
    const approval = router.requestToolApproval(
        { id: "call-1", name: "bash", input: { command: "true" } },
        "needs approval",
        { timeoutMs: 60_000 },
    );

    router.halt("halted for approval");

    expect(await approval).toEqual({
        behavior: "deny",
        reason: "halted for approval",
    });
});
