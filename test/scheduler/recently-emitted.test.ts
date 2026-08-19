import { expect, test } from "bun:test";

import { ScheduleStore } from "../../src/scheduler/store.ts";

function seed(
    store: ScheduleStore,
    id: string,
    address: string,
    scheduledFor: string,
): void {
    store.create({
        id,
        cron: "0 9 * * *",
        timezone: "UTC",
        address,
        payload: '{"text":"run"}',
        nextRunAt: scheduledFor,
        now: "2026-08-09T20:00:00.000Z",
    });
    store.planDue(id, scheduledFor, "2026-08-20T09:00:00.000Z", scheduledFor);
}

test("only emitted runs are reported, newest first, with their address", () => {
    const store = ScheduleStore.open(":memory:");
    try {
        seed(store, "nightly", "agent-one", "2026-08-14T09:00:00.000Z");
        seed(store, "weekly", "agent-two", "2026-08-14T10:00:00.000Z");
        seed(store, "pending-one", "agent-three", "2026-08-14T11:00:00.000Z");

        store.markEmitted(
            "nightly",
            "2026-08-14T09:00:00.000Z",
            1,
            "2026-08-14T09:00:01.000Z",
        );
        store.markEmitted(
            "weekly",
            "2026-08-14T10:00:00.000Z",
            2,
            "2026-08-14T10:00:01.000Z",
        );

        const emitted = store.recentlyEmitted(10);
        expect(emitted.map((run) => run.scheduleId))
            .toEqual(["weekly", "nightly"]);
        expect(emitted.map((run) => run.address))
            .toEqual(["agent-two", "agent-one"]);
        expect(emitted[0]?.emittedAt).toBe("2026-08-14T10:00:01.000Z");
        expect(emitted.every((run) => run.status === "emitted")).toBe(true);
    } finally {
        store.close();
    }
});

test("the reported runs are bounded and the bound is validated", () => {
    const store = ScheduleStore.open(":memory:");
    try {
        for (let index = 0; index < 5; index += 1) {
            const scheduledFor = `2026-08-14T0${index}:00:00.000Z`;
            seed(store, `run-${index}`, "agent-one", scheduledFor);
            store.markEmitted(
                `run-${index}`,
                scheduledFor,
                index,
                `2026-08-14T0${index}:00:01.000Z`,
            );
        }

        expect(store.recentlyEmitted(2)).toHaveLength(2);
        expect(() => store.recentlyEmitted(0)).toThrow();
        expect(() => store.recentlyEmitted(1.5)).toThrow();
    } finally {
        store.close();
    }
});

test("a store with nothing emitted reports nothing", () => {
    const store = ScheduleStore.open(":memory:");
    try {
        seed(store, "nightly", "agent-one", "2026-08-14T09:00:00.000Z");
        expect(store.recentlyEmitted(10)).toEqual([]);
    } finally {
        store.close();
    }
});
