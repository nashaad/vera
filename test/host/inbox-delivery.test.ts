import { describe, expect, test } from "bun:test";

import { Inbox, type InboxEntryInput } from "../../src/store/inbox.ts";
import { ConsumerRegistry } from "../../src/host/consumers.ts";
import {
    InboxDeliveryCoordinator,
    type AttachInboxConsumerRequest,
} from "../../src/host/inbox-delivery.ts";
import type { PendingDelivery } from "../../src/store/session-store.ts";

const SESSION = "session-1";

class FakeTarget {
    readonly recorded: PendingDelivery[] = [];
    readonly wakes: PendingDelivery[] = [];
    answered = new Set<string>();

    recordDelivery(delivery: PendingDelivery): Promise<boolean> {
        const existing = this.recorded.find((entry) => entry.id === delivery.id);
        if (existing !== undefined) {
            return Promise.resolve(false);
        }
        this.recorded.push(delivery);
        return Promise.resolve(true);
    }

    pendingDeliveryIds(): readonly string[] {
        return this.recorded
            .map((delivery) => delivery.id)
            .filter((id) => !this.answered.has(id));
    }
}

interface Harness {
    readonly inbox: Inbox;
    readonly consumers: ConsumerRegistry;
    readonly coordinator: InboxDeliveryCoordinator;
    readonly target: FakeTarget;
    setNow(ms: number): void;
    runTimers(): void;
    attach(overrides?: Partial<AttachInboxConsumerRequest>): ReturnType<
        InboxDeliveryCoordinator["attach"]
    >;
}

function harness(options: {
    minWakeIntervalMs?: number;
    maxEntriesPerWake?: number;
    inbox?: Inbox;
    target?: FakeTarget;
} = {}): Harness {
    const inbox = options.inbox ?? Inbox.open(":memory:");
    const consumers = new ConsumerRegistry(inbox, "node-a");
    const target = options.target ?? new FakeTarget();
    let now = 1_000;
    const timers: (() => void)[] = [];
    const coordinator = new InboxDeliveryCoordinator(consumers, {
        ...(options.maxEntriesPerWake === undefined
            ? {}
            : { maxEntriesPerWake: options.maxEntriesPerWake }),
        now: () => now,
        setTimer: (run) => {
            timers.push(run);
            return timers.length;
        },
        clearTimer: () => {},
    });
    return {
        inbox,
        consumers,
        coordinator,
        target,
        setNow: (ms) => {
            now = ms;
        },
        runTimers: () => {
            const due = timers.splice(0, timers.length);
            for (const run of due) run();
        },
        attach: (overrides = {}) =>
            coordinator.attach({
                label: "worker",
                session: SESSION,
                target,
                triggerTurn: () => {
                    const last = target.recorded[target.recorded.length - 1];
                    if (last !== undefined) target.wakes.push(last);
                },
                ...(options.minWakeIntervalMs === undefined
                    ? { minWakeIntervalMs: 0 }
                    : { minWakeIntervalMs: options.minWakeIntervalMs }),
                ...overrides,
            }),
    };
}

function entry(overrides: Partial<InboxEntryInput> = {}): InboxEntryInput {
    return {
        source: "arc",
        kind: "post",
        payload: JSON.stringify({ issue: "nash-93" }),
        ...overrides,
    };
}

describe("inbox delivery", () => {
    test("a burst of entries becomes one delivery carrying all of them", async () => {
        const bench = harness();
        const session = bench.attach();
        bench.inbox.appendAll([entry(), entry(), entry()]);

        await session.pump();

        expect(bench.target.recorded).toHaveLength(1);
        expect(bench.target.wakes).toHaveLength(1);
        expect(bench.target.recorded[0]!.content).toContain("3 new inbox entries.");
        expect(bench.target.recorded[0]!.sourceAgentId).toBe("inbox");
        expect(session.consumer.lag()).toBe(0);
    });

    test("an empty log records nothing and wakes nobody", async () => {
        const bench = harness();
        const session = bench.attach();

        await session.pump();

        expect(bench.target.recorded).toHaveLength(0);
        expect(bench.target.wakes).toHaveLength(0);
    });

    test("a new consumer starts at the tail instead of replaying history", async () => {
        const bench = harness();
        bench.inbox.appendAll([entry(), entry()]);
        const session = bench.attach();

        await session.pump();

        expect(bench.target.recorded).toHaveLength(0);
    });

    test("a session's own entries never wake it", async () => {
        const bench = harness();
        const session = bench.attach({ actor: "nash" });
        bench.inbox.append(entry({ actor: "nash", session: SESSION }));

        await session.pump();

        expect(bench.target.recorded).toHaveLength(0);
        expect(bench.target.wakes).toHaveLength(0);

        bench.inbox.append(entry({ actor: "someone-else", session: "other" }));
        await session.pump();

        expect(bench.target.recorded).toHaveLength(1);
        expect(bench.target.recorded[0]!.content).toContain("someone-else");
        expect(bench.target.recorded[0]!.content).not.toContain("by nash ");
    });

    test("the delivery content carries no seq, offset or cursor", async () => {
        const bench = harness();
        const session = bench.attach();
        bench.inbox.append(entry());

        await session.pump();

        const content = bench.target.recorded[0]!.content;
        expect(content).not.toContain("seq");
        expect(content).not.toContain("offset");
        expect(content).not.toContain("cursor");
    });

    test("the rate limit coalesces rather than drops", async () => {
        const bench = harness({ minWakeIntervalMs: 5_000 });
        const session = bench.attach();
        bench.inbox.append(entry());
        await session.pump();
        expect(bench.target.wakes).toHaveLength(1);

        bench.setNow(2_000);
        bench.inbox.appendAll([entry(), entry(), entry()]);
        await session.pump();

        expect(bench.target.recorded).toHaveLength(1);

        bench.setNow(6_001);
        bench.runTimers();
        await bench.coordinator.pumpAll();

        expect(bench.target.recorded).toHaveLength(2);
        expect(bench.target.wakes).toHaveLength(2);
        expect(bench.target.recorded[1]!.content).toContain("3 new inbox entries.");
    });

    test("a delivery larger than one wake keeps going until the log is drained", async () => {
        const bench = harness({ maxEntriesPerWake: 2 });
        const session = bench.attach();
        bench.inbox.appendAll([entry(), entry(), entry(), entry(), entry()]);

        await session.pump();

        expect(bench.target.recorded).toHaveLength(3);
        expect(session.consumer.lag()).toBe(0);
    });

    test("a crash between recording and advancing replays exactly once", async () => {
        const inbox = Inbox.open(":memory:");
        const target = new FakeTarget();
        const before = harness({ inbox, target });
        const first = before.attach();
        inbox.appendAll([entry(), entry()]);
        await first.pump();
        const recordedId = target.recorded[0]!.id;

        // The crash: the delivery is durable, the offset never moved.
        first.consumer.advance(0);
        const rewound = new ConsumerRegistry(inbox, "node-a");
        rewound.hello({ label: "worker" });
        inbox.advance({ nodeId: "node-a", label: "worker" }, 0);
        first.release();

        const after = harness({ inbox, target });
        const restarted = after.attach();
        await restarted.pump();

        expect(target.recorded).toHaveLength(1);
        expect(target.recorded[0]!.id).toBe(recordedId);
        expect(target.pendingDeliveryIds()).toEqual([recordedId]);
    });

    test("a delivery whose turn completed is not replayed at boot", async () => {
        const inbox = Inbox.open(":memory:");
        const target = new FakeTarget();
        const before = harness({ inbox, target });
        const first = before.attach();
        inbox.append(entry());
        await first.pump();
        target.answered.add(target.recorded[0]!.id);
        first.release();

        const after = harness({ inbox, target });
        const restarted = after.attach();
        await restarted.pump();

        expect(target.recorded).toHaveLength(1);
        expect(target.wakes).toHaveLength(1);
    });

    test("a released session stops delivering", async () => {
        const bench = harness();
        const session = bench.attach();
        session.release();
        bench.inbox.append(entry());

        await session.pump();
        await bench.coordinator.pumpAll();

        expect(bench.target.recorded).toHaveLength(0);
    });

    test("pumpAll delivers to every attached session", async () => {
        const bench = harness();
        const first = bench.attach();
        const secondTarget = new FakeTarget();
        const second = bench.attach({
            label: "worker",
            session: "session-2",
            target: secondTarget,
            triggerTurn: () => {
                secondTarget.wakes.push(secondTarget.recorded[0]!);
            },
        });
        expect(second.consumer.label).toBe("worker-2");

        bench.inbox.append(entry());
        await bench.coordinator.pumpAll();

        expect(bench.target.recorded).toHaveLength(1);
        expect(secondTarget.recorded).toHaveLength(1);
        expect(first.consumer.lag()).toBe(0);
    });
});
