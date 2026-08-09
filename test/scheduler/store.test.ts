import { expect, test } from "bun:test";

import { ScheduleStore } from "../../src/scheduler/store.ts";

test("schedule definitions and runs have separate durable state", () => {
    const store = ScheduleStore.open(":memory:");
    const schedule = store.create({
        id: "daily-review",
        cron: "0 9 * * *",
        timezone: "UTC",
        address: "claude:one",
        payload: '{"text":"Review open work"}',
        nextRunAt: "2026-08-10T09:00:00.000Z",
        now: "2026-08-09T20:00:00.000Z",
    });
    expect(schedule).toMatchObject({ id: "daily-review", enabled: true });
    expect(store.due("2026-08-10T08:59:59.999Z")).toEqual([]);
    expect(store.due("2026-08-10T09:00:00.000Z")).toHaveLength(1);

    expect(store.planDue(
        schedule.id,
        schedule.nextRunAt,
        "2026-08-11T09:00:00.000Z",
        "2026-08-10T09:00:00.000Z",
    )).toBe(true);
    expect(store.pendingRuns()).toMatchObject([{
        scheduleId: "daily-review",
        scheduledFor: "2026-08-10T09:00:00.000Z",
        status: "pending",
    }]);
    store.markEmitted(
        "daily-review",
        "2026-08-10T09:00:00.000Z",
        42,
        "2026-08-10T09:00:01.000Z",
    );
    expect(store.listRuns("daily-review")).toMatchObject([{
        status: "emitted",
        inboxSeq: 42,
    }]);
    store.close();
});

test("schedule mutation refuses collisions and preserves pause state", () => {
    const store = ScheduleStore.open(":memory:");
    const input = {
        id: "review",
        cron: "*/5 * * * *",
        timezone: "UTC",
        address: "vera-a",
        payload: "{}",
        nextRunAt: "2026-08-09T20:05:00.000Z",
        now: "2026-08-09T20:00:00.000Z",
    };
    store.create(input);
    expect(() => store.create(input)).toThrow("already exists");
    expect(store.setEnabled("review", false, input.now).enabled).toBe(false);
    expect(store.nextDueAt()).toBeNull();
    expect(store.setEnabled("review", true, input.now).enabled).toBe(true);
    expect(store.remove("review")).toBe(true);
    expect(store.remove("review")).toBe(false);
    store.close();
});
