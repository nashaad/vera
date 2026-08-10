import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Inbox } from "../../src/store/inbox.ts";
import { SchedulerRuntime, nextOccurrence } from "../../src/scheduler/runtime.ts";
import { ScheduleStore } from "../../src/scheduler/store.ts";
import {
    MAX_SCHEDULE_ADDRESS_BYTES,
    MAX_SCHEDULE_CRON_BYTES,
    MAX_SCHEDULE_PAYLOAD_BYTES,
    MAX_SCHEDULE_RUN_RESULTS,
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

test("append recovery remains idempotent after both databases reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-schedule-restart-"));
    const inboxPath = join(root, "inbox.db");
    const schedulePath = join(root, "schedules.db");
    let now = new Date("2026-08-09T20:00:00.000Z");
    let inbox = Inbox.open(inboxPath);
    let store = ScheduleStore.open(schedulePath);
    let runtime = new SchedulerRuntime({
        store,
        now: () => now,
        autoStart: false,
        emit: async (key, entry) => {
            inbox.appendOnce(SCHEDULER_SOURCE, key, entry);
            throw new Error("crash after durable append");
        },
    });
    try {
        await runtime.execute({
            action: "add",
            id: "restart",
            cron: "* * * * *",
            timezone: "UTC",
            address: "worker",
            payload: { text: "once" },
        });
        now = new Date("2026-08-09T20:01:00.000Z");
        await expect(runtime.runDue()).rejects.toThrow("crash after durable append");
        await runtime.close();
        store.close();
        inbox.close();

        inbox = Inbox.open(inboxPath);
        store = ScheduleStore.open(schedulePath);
        runtime = new SchedulerRuntime({
            store,
            now: () => now,
            autoStart: false,
            emit: async (key, entry) =>
                inbox.appendOnce(SCHEDULER_SOURCE, key, entry),
        });
        await runtime.runDue();

        expect(inbox.tail()).toBe(1);
        expect(store.pendingRuns()).toEqual([]);
        expect(store.listRuns("restart")).toMatchObject([{
            status: "emitted",
            inboxSeq: 1,
        }]);
    } finally {
        await runtime.close();
        store.close();
        inbox.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("competing runtimes emit each due occurrence once", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-schedule-race-"));
    const inboxPath = join(root, "inbox.db");
    const schedulePath = join(root, "schedules.db");
    const firstInbox = Inbox.open(inboxPath);
    const secondInbox = Inbox.open(inboxPath);
    const firstStore = ScheduleStore.open(schedulePath);
    const secondStore = ScheduleStore.open(schedulePath);
    let now = new Date("2026-08-09T20:00:00.000Z");
    const first = new SchedulerRuntime({
        store: firstStore,
        now: () => now,
        autoStart: false,
        emit: async (key, entry) =>
            firstInbox.appendOnce(SCHEDULER_SOURCE, key, entry),
    });
    const second = new SchedulerRuntime({
        store: secondStore,
        now: () => now,
        autoStart: false,
        emit: async (key, entry) =>
            secondInbox.appendOnce(SCHEDULER_SOURCE, key, entry),
    });
    try {
        for (let index = 0; index < 20; index += 1) {
            await first.execute({
                action: "add",
                id: `race-${index}`,
                cron: "* * * * *",
                timezone: "UTC",
                address: "worker",
                payload: { index },
            });
        }
        now = new Date("2026-08-09T20:01:00.000Z");
        await Promise.all([
            first.runDue(),
            second.runDue(),
            first.runDue(),
            second.runDue(),
        ]);

        expect(firstInbox.tail()).toBe(20);
        expect(firstStore.pendingRuns()).toEqual([]);
        expect(firstStore.list().reduce(
            (count, schedule) =>
                count + firstStore.listRuns(schedule.id)
                    .filter((run) => run.status === "emitted").length,
            0,
        )).toBe(20);
    } finally {
        await first.close();
        await second.close();
        firstStore.close();
        secondStore.close();
        firstInbox.close();
        secondInbox.close();
        await rm(root, { recursive: true, force: true });
    }
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

test("a replaced timer ignores its already-queued stale callback", async () => {
    const store = ScheduleStore.open(":memory:");
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const runtime = new SchedulerRuntime({
        store,
        now: () => new Date("2026-08-09T20:00:00.000Z"),
        setTimer: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimer: () => undefined,
        emit: async () => { throw new Error("not due"); },
    });
    await runtime.execute({
        action: "add",
        id: "first",
        cron: "* * * * *",
        timezone: "UTC",
        address: "worker",
        payload: {},
    });
    await runtime.execute({
        action: "add",
        id: "second",
        cron: "*/2 * * * *",
        timezone: "UTC",
        address: "worker",
        payload: {},
    });
    expect(timers).toHaveLength(2);

    timers[0]!.callback();
    await Bun.sleep(1);
    expect(timers).toHaveLength(2);
    await runtime.close();
    store.close();
});

test("long sleeps recheck the wall clock once a minute", async () => {
    const store = ScheduleStore.open(":memory:");
    let now = new Date("2026-08-09T20:00:00.000Z");
    let timer: { callback: () => void; delay: number } | undefined;
    const inbox = Inbox.open(":memory:");
    const runtime = new SchedulerRuntime({
        store,
        now: () => now,
        setTimer: (callback, delay) => {
            timer = { callback, delay };
            return callback;
        },
        clearTimer: () => undefined,
        emit: async (key, entry) => inbox.appendOnce(SCHEDULER_SOURCE, key, entry),
    });
    await runtime.execute({
        action: "add",
        id: "daily",
        cron: "0 20 * * *",
        timezone: "UTC",
        address: "worker",
        payload: {},
    });
    expect(timer?.delay).toBe(60_000);

    now = new Date("2026-08-10T20:00:00.000Z");
    timer!.callback();
    for (let attempt = 0; attempt < 100 && inbox.tail() === 0; attempt += 1) {
        await Bun.sleep(1);
    }
    expect(inbox.tail()).toBe(1);
    await runtime.close();
    store.close();
    inbox.close();
});

test("an invalid persisted next time is paused instead of spinning", async () => {
    const store = ScheduleStore.open(":memory:");
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const errors: string[] = [];
    store.create({
        id: "bad-time",
        cron: "* * * * *",
        timezone: "UTC",
        address: "worker",
        payload: "{}",
        nextRunAt: "!not-a-time",
        now: "2026-08-09T20:00:00.000Z",
    });
    store.create({
        id: "healthy-time",
        cron: "0 21 * * *",
        timezone: "UTC",
        address: "worker",
        payload: "{}",
        nextRunAt: "2026-08-09T21:00:00.000Z",
        now: "2026-08-09T20:00:00.000Z",
    });
    const runtime = new SchedulerRuntime({
        store,
        now: () => new Date("2026-08-09T20:00:00.000Z"),
        setTimer: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimer: () => undefined,
        onError: (error) => errors.push(String(error)),
        emit: async () => { throw new Error("not due"); },
    });

    await runtime.start();
    expect(store.get("bad-time")?.enabled).toBe(false);
    expect(store.get("healthy-time")?.enabled).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBe(60_000);
    expect(errors).toEqual([
        "Error: paused invalid schedule bad-time: invalid next_run_at !not-a-time",
    ]);
    await runtime.close();
    store.close();
});

test("one failed occurrence does not block another and retries back off", async () => {
    const inbox = Inbox.open(":memory:");
    const store = ScheduleStore.open(":memory:");
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const runtime = new SchedulerRuntime({
        store,
        now: () => new Date("2026-08-09T20:00:00.000Z"),
        setTimer: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimer: () => undefined,
        emit: async (key, entry) => {
            if (entry.address === "broken") throw new Error("recipient failure");
            return inbox.appendOnce(SCHEDULER_SOURCE, key, entry);
        },
    });
    for (const [id, address] of [["bad", "broken"], ["good", "healthy"]] as const) {
        await runtime.execute({
            action: "add",
            id,
            cron: "* * * * *",
            timezone: "UTC",
            address,
            payload: { id },
        });
        store.createManualRun(id, new Date("2026-08-09T20:00:00.000Z"));
    }

    await expect(runtime.runDue()).rejects.toThrow("recipient failure");
    expect(inbox.tail()).toBe(1);
    expect(inbox.entry(1)?.address).toBe("healthy");
    expect(store.pendingRuns()).toHaveLength(1);
    expect(timers.at(-1)?.delay).toBe(1_000);

    timers.at(-1)!.callback();
    for (let attempt = 0; attempt < 100 && timers.at(-1)?.delay !== 2_000; attempt += 1) {
        await Bun.sleep(1);
    }
    expect(timers.at(-1)?.delay).toBe(2_000);
    expect(inbox.tail()).toBe(1);
    await runtime.close();
    store.close();
    inbox.close();
});

test("an invalid persisted cron is paused without blocking healthy work", async () => {
    const now = new Date("2026-08-09T20:02:00.000Z");
    const inbox = Inbox.open(":memory:");
    const store = ScheduleStore.open(":memory:");
    const errors: string[] = [];
    store.create({
        id: "bad",
        cron: "not cron",
        timezone: "UTC",
        address: "worker",
        payload: "{}",
        nextRunAt: "2026-08-09T20:01:00.000Z",
        now: "2026-08-09T20:00:00.000Z",
    });
    store.create({
        id: "good",
        cron: "* * * * *",
        timezone: "UTC",
        address: "worker",
        payload: "{}",
        nextRunAt: "2026-08-09T20:01:00.000Z",
        now: "2026-08-09T20:00:00.000Z",
    });
    const runtime = new SchedulerRuntime({
        store,
        now: () => now,
        autoStart: false,
        onError: (error) => errors.push(String(error)),
        emit: async (key, entry) => inbox.appendOnce(SCHEDULER_SOURCE, key, entry),
    });

    await runtime.runDue();
    expect(store.get("bad")?.enabled).toBe(false);
    expect(store.get("good")?.nextRunAt).toBe("2026-08-09T20:03:00.000Z");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("paused invalid schedule bad");
    expect(inbox.tail()).toBe(1);
    await runtime.close();
    store.close();
    inbox.close();
});

test("scheduler control fields and returned history are bounded", async () => {
    const test = fixture(new Date("2026-08-09T20:00:00.000Z"));
    await expect(test.runtime.execute({
        action: "add",
        id: "long-address",
        cron: "* * * * *",
        timezone: "UTC",
        address: "x".repeat(MAX_SCHEDULE_ADDRESS_BYTES + 1),
        payload: {},
    })).rejects.toThrow(`at most ${MAX_SCHEDULE_ADDRESS_BYTES} bytes`);
    expect(() => nextOccurrence(
        `${"1".repeat(MAX_SCHEDULE_CRON_BYTES)} * * * *`,
        "UTC",
        new Date(),
    )).toThrow(`at most ${MAX_SCHEDULE_CRON_BYTES} bytes`);

    await test.runtime.execute({
        action: "add",
        id: "history",
        cron: "* * * * *",
        timezone: "UTC",
        address: "worker",
        payload: { text: "not repeated by list" },
    });
    for (let index = 0; index < MAX_SCHEDULE_RUN_RESULTS + 1; index += 1) {
        test.store.createManualRun(
            "history",
            new Date(Date.UTC(2026, 7, 9, 20, 0, 0, index)),
        );
    }
    const listed = await test.runtime.execute({ action: "list" });
    expect((listed.schedules as Array<Record<string, unknown>>)[0])
        .not.toHaveProperty("payload");
    const shown = await test.runtime.execute({ action: "show", id: "history" });
    expect(shown).toMatchObject({
        run_count: MAX_SCHEDULE_RUN_RESULTS + 1,
        runs_truncated: true,
    });
    expect(shown.runs).toHaveLength(MAX_SCHEDULE_RUN_RESULTS);

    await test.runtime.close();
    await expect(test.runtime.execute({ action: "list" }))
        .rejects.toThrow("Scheduler is closed");
    test.store.close();
    test.inbox.close();
});
