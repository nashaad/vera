import { expect, test } from "bun:test";

import { Inbox } from "../../src/store/inbox.ts";
import { SchedulerRuntime, nextOccurrence } from "../../src/scheduler/runtime.ts";
import { ScheduleStore } from "../../src/scheduler/store.ts";
import {
    MAX_SCHEDULE_PAYLOAD_BYTES,
    SCHEDULER_SOURCE,
} from "../../src/scheduler/types.ts";

function fixture(now: Date) {
    const inbox = Inbox.open(":memory:");
    const store = ScheduleStore.open(":memory:");
    let current = now;
    const runtime = new SchedulerRuntime({
        store,
        now: () => current,
        autoStart: false,
        emit: async (key, entry) => inbox.appendOnce(SCHEDULER_SOURCE, key, entry),
    });
    return {
        inbox,
        store,
        runtime,
        setNow(value: Date) {
            current = value;
        },
        async close() {
            await runtime.close();
            store.close();
            inbox.close();
        },
    };
}

test("cron calculation is five-field and timezone-aware", () => {
    expect(nextOccurrence(
        "0 9 * * *",
        "America/New_York",
        new Date("2026-08-09T12:00:00.000Z"),
    ).toISOString()).toBe("2026-08-09T13:00:00.000Z");
    expect(() => nextOccurrence(
        "* * * * * *",
        "UTC",
        new Date(),
    )).toThrow("exactly five fields");
    expect(() => nextOccurrence(
        "not cron",
        "UTC",
        new Date(),
    )).toThrow("exactly five fields");
    expect(() => nextOccurrence(
        "0 9 * * *",
        "Mars/Olympus",
        new Date(),
    )).toThrow("invalid schedule cron or timezone");
});

test("downtime coalesces to one occurrence and advances past now", async () => {
    const start = new Date("2026-08-09T20:00:00.000Z");
    const test = fixture(start);
    await test.runtime.execute({
        action: "add",
        id: "minute-review",
        cron: "* * * * *",
        timezone: "UTC",
        address: "claude:one",
        payload: { text: "Review" },
    });
    test.setNow(new Date("2026-08-09T20:05:30.000Z"));
    await test.runtime.runDue();
    await test.runtime.runDue();

    expect(test.inbox.tail()).toBe(1);
    expect(test.inbox.entry(1)).toMatchObject({
        source: "vera.scheduler",
        kind: "schedule.triggered",
        actor: "scheduler:minute-review",
        address: "claude:one",
        ts: "2026-08-09T20:01:00.000Z",
    });
    expect(test.store.get("minute-review")?.nextRunAt)
        .toBe("2026-08-09T20:06:00.000Z");
    expect(test.store.listRuns("minute-review")).toMatchObject([{
        status: "emitted",
        inboxSeq: 1,
    }]);
    await test.close();
});

test("a crash after append retries the same inbox occurrence", async () => {
    const inbox = Inbox.open(":memory:");
    const store = ScheduleStore.open(":memory:");
    let now = new Date("2026-08-09T20:00:00.000Z");
    let failAfterAppend = true;
    const runtime = new SchedulerRuntime({
        store,
        now: () => now,
        autoStart: false,
        emit: async (key, entry) => {
            const result = inbox.appendOnce(SCHEDULER_SOURCE, key, entry);
            if (failAfterAppend) throw new Error("simulated crash");
            return result;
        },
    });
    await runtime.execute({
        action: "add",
        id: "recover",
        cron: "* * * * *",
        timezone: "UTC",
        address: "codex:two",
        payload: { text: "Recover" },
    });
    now = new Date("2026-08-09T20:01:00.000Z");
    await expect(runtime.runDue()).rejects.toThrow("simulated crash");
    expect(inbox.tail()).toBe(1);
    expect(store.pendingRuns()).toHaveLength(1);

    failAfterAppend = false;
    await runtime.runDue();
    expect(inbox.tail()).toBe(1);
    expect(store.pendingRuns()).toEqual([]);
    expect(store.listRuns("recover")[0]).toMatchObject({
        status: "emitted",
        inboxSeq: 1,
    });
    await runtime.close();
    store.close();
    inbox.close();
});

test("pause blocks clock runs while manual run remains explicit", async () => {
    const test = fixture(new Date("2026-08-09T20:00:00.000Z"));
    await test.runtime.execute({
        action: "add",
        id: "paused",
        cron: "* * * * *",
        timezone: "UTC",
        address: "vera-a",
        payload: { text: "Run me" },
    });
    await test.runtime.execute({ action: "pause", id: "paused" });
    test.setNow(new Date("2026-08-09T20:10:00.000Z"));
    await test.runtime.runDue();
    expect(test.inbox.tail()).toBe(0);
    await test.runtime.execute({ action: "run", id: "paused" });
    expect(test.inbox.tail()).toBe(1);
    expect(JSON.parse(test.inbox.entry(1)!.payload)).toMatchObject({
        schedule_id: "paused",
        payload: { text: "Run me" },
    });
    await test.close();
});

test("large payloads stay intact and oversized payloads are refused", async () => {
    const test = fixture(new Date("2026-08-09T20:00:00.000Z"));
    const text = "x".repeat(MAX_SCHEDULE_PAYLOAD_BYTES - 32);
    await test.runtime.execute({
        action: "add",
        id: "large",
        cron: "* * * * *",
        timezone: "UTC",
        address: "codex:large",
        payload: { text },
    });
    await test.runtime.execute({ action: "run", id: "large" });
    expect(JSON.parse(test.inbox.entry(1)!.payload)).toMatchObject({
        schedule_id: "large",
        payload: { text },
    });

    await expect(test.runtime.execute({
        action: "add",
        id: "too-large",
        cron: "* * * * *",
        timezone: "UTC",
        address: "codex:large",
        payload: { text: "x".repeat(MAX_SCHEDULE_PAYLOAD_BYTES) },
    })).rejects.toThrow(`at most ${MAX_SCHEDULE_PAYLOAD_BYTES} bytes`);
    expect(test.store.get("too-large")).toBeUndefined();
    await test.close();
});

test("a transient emission failure keeps one short retry timer", async () => {
    const inbox = Inbox.open(":memory:");
    const store = ScheduleStore.open(":memory:");
    let now = new Date("2026-08-09T20:00:00.000Z");
    let fail = true;
    let scheduled: { callback: () => void; delay: number } | undefined;
    let reportError: ((error: unknown) => void) | undefined;
    const errorReported = new Promise<unknown>((resolve) => {
        reportError = resolve;
    });
    const runtime = new SchedulerRuntime({
        store,
        now: () => now,
        setTimer: (callback, delay) => {
            scheduled = { callback, delay };
            return callback;
        },
        clearTimer: () => undefined,
        onError: (error) => reportError?.(error),
        emit: async (key, entry) => {
            if (fail) throw new Error("inbox temporarily unavailable");
            return inbox.appendOnce(SCHEDULER_SOURCE, key, entry);
        },
    });
    await runtime.execute({
        action: "add",
        id: "retry",
        cron: "* * * * *",
        timezone: "UTC",
        address: "claude:one",
        payload: { text: "Retry" },
    });
    expect(scheduled?.delay).toBe(60_000);

    now = new Date("2026-08-09T20:01:00.000Z");
    scheduled!.callback();
    expect(await errorReported).toBeInstanceOf(Error);
    expect(store.pendingRuns()).toHaveLength(1);
    expect(scheduled?.delay).toBe(1_000);

    fail = false;
    scheduled!.callback();
    for (let attempt = 0; attempt < 100 && store.pendingRuns().length > 0; attempt += 1) {
        await Bun.sleep(1);
    }
    expect(store.pendingRuns()).toEqual([]);
    expect(inbox.tail()).toBe(1);
    await runtime.close();
    store.close();
    inbox.close();
});
