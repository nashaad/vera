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

test("an abort command stops a running manual compaction", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    let operationSignal: AbortSignal | undefined;
    let stopped = false;
    const router = new InboundCommandRouter(
        channel.engine,
        events,
        {
            compactNow: async (_turnActive, signal) => {
                operationSignal = signal;
                await new Promise<void>((resolve) => {
                    signal?.addEventListener("abort", () => {
                        stopped = true;
                        resolve();
                    }, { once: true });
                });
            },
        },
    );
    void router;

    channel.client.send({ type: "compact", requestId: "ask-stop" });
    await settle();
    expect(operationSignal).toBeDefined();

    channel.client.send({ type: "abort" });
    await settle();

    expect(stopped).toBe(true);
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

test("a queued prompt counts as a turn already underway", async () => {
    // The prompt can be claimed while the compaction is still running, and a
    // compaction under a turn is exactly what the check exists to prevent.
    const channel = createInProcessChannel();
    let asked: boolean | undefined;
    const router = new InboundCommandRouter(
        channel.engine,
        new EngineEventBus(),
        { compactNow: async (turnActive) => void (asked = turnActive) },
    );
    void router;

    channel.client.send({ type: "prompt", content: "queued" });
    channel.client.send({ type: "compact", requestId: "ask-4" });
    await settle();

    expect(asked).toBe(true);
});

test("a claimed prompt stays timeline-blocked while compaction finishes", async () => {
    const channel = createInProcessChannel();
    const compactionStarted = deferred<void>();
    const releaseCompaction = deferred<void>();
    const blocked: boolean[] = [];
    let router: InboundCommandRouter;
    router = new InboundCommandRouter(
        channel.engine,
        new EngineEventBus(),
        {
            compactNow: async () => {
                compactionStarted.resolve(undefined);
                await releaseCompaction.promise;
            },
            handleTimelineCommand: async () => {
                blocked.push(router.timelineBlocked());
            },
        },
    );

    channel.client.send({ type: "compact", requestId: "ask-before" });
    await compactionStarted.promise;
    channel.client.send({ type: "prompt", content: "queued" });
    const turn = router.startTurn();
    await settle();

    channel.client.send({ type: "list_timeline", requestId: "list-while" });
    await settle();
    expect(blocked).toEqual([true]);

    releaseCompaction.resolve(undefined);
    expect((await turn).prompt.content).toBe("queued");
    router.finishTurn();
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

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
