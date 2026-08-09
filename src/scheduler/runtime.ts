import { Cron } from "croner";

import type { InboxEntry, InboxEntryInput } from "../store/inbox.ts";
import { UserFacingError } from "../user-facing-error.ts";
import { ScheduleStore } from "./store.ts";
import {
    MAX_SCHEDULE_PAYLOAD_BYTES,
    SCHEDULER_SOURCE,
    SCHEDULE_TRIGGERED_KIND,
    type PendingScheduleRun,
    type ScheduleDefinition,
    type ScheduleOperation,
    type ScheduleTriggeredPayload,
} from "./types.ts";

const SCHEDULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TIMER_MS = 2_147_000_000;
const PENDING_RETRY_MS = 1_000;

export interface SchedulerRuntimeOptions {
    readonly store: ScheduleStore;
    readonly emit: (
        key: string,
        entry: InboxEntryInput,
    ) => Promise<{ readonly entry: InboxEntry; readonly created: boolean }>;
    readonly now?: () => Date;
    readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
    readonly onError?: (error: unknown) => void;
    readonly autoStart?: boolean;
}

export class SchedulerRuntime {
    private readonly clock: () => Date;
    private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
    private readonly clearTimer: (timer: unknown) => void;
    private queue: Promise<void> = Promise.resolve();
    private timer: unknown;
    private closed = false;

    constructor(private readonly options: SchedulerRuntimeOptions) {
        this.clock = options.now ?? (() => new Date());
        this.setTimer = options.setTimer ?? ((callback, delayMs) =>
            setTimeout(callback, delayMs));
        this.clearTimer = options.clearTimer ?? ((timer) =>
            clearTimeout(timer as ReturnType<typeof setTimeout>));
    }

    async start(): Promise<void> {
        if (this.options.autoStart === false) return;
        try {
            await this.runDue();
        } catch (error) {
            this.options.onError?.(error);
        }
    }

    execute(operation: ScheduleOperation): Promise<Record<string, unknown>> {
        return this.enqueue(async () => {
            try {
                switch (operation.action) {
                    case "add": {
                        validateId(operation.id);
                        validateAddress(operation.address);
                        const payload = JSON.stringify(operation.payload);
                        if (Buffer.byteLength(payload, "utf8") > MAX_SCHEDULE_PAYLOAD_BYTES) {
                            throw new Error(
                                `schedule payload must encode to at most ${MAX_SCHEDULE_PAYLOAD_BYTES} bytes`,
                            );
                        }
                        const now = this.clock();
                        const next = nextOccurrence(
                            operation.cron,
                            operation.timezone,
                            now,
                        );
                        const schedule = this.options.store.create({
                            id: operation.id,
                            cron: operation.cron,
                            timezone: operation.timezone,
                            address: operation.address,
                            payload,
                            nextRunAt: next.toISOString(),
                            now: now.toISOString(),
                        });
                        return scheduleResult(schedule);
                    }
                    case "list":
                        return {
                            schedules: this.options.store.list().map(scheduleResult),
                        };
                    case "show": {
                        const schedule = this.requireSchedule(operation.id);
                        return {
                            ...scheduleResult(schedule),
                            runs: this.options.store.listRuns(operation.id)
                                .map(runResult),
                        };
                    }
                    case "pause":
                        return scheduleResult(this.options.store.setEnabled(
                            operation.id,
                            false,
                            this.clock().toISOString(),
                        ));
                    case "resume":
                        return scheduleResult(this.options.store.setEnabled(
                            operation.id,
                            true,
                            this.clock().toISOString(),
                        ));
                    case "remove":
                        if (!this.options.store.remove(operation.id)) {
                            throw new Error(`unknown schedule ${operation.id}`);
                        }
                        return { removed: true, schedule_id: operation.id };
                    case "run": {
                        this.options.store.createManualRun(
                            operation.id,
                            this.clock(),
                        );
                        await this.deliverPending();
                        return {
                            schedule_id: operation.id,
                            triggered: true,
                        };
                    }
                }
            } catch (error) {
                throw error instanceof UserFacingError
                    ? error
                    : new UserFacingError(
                        error instanceof Error ? error.message : String(error),
                    );
            } finally {
                this.scheduleTimer();
            }
        });
    }

    runDue(): Promise<void> {
        return this.enqueue(async () => {
            if (this.closed) return;
            try {
                const now = this.clock();
                const nowIso = now.toISOString();
                for (const schedule of this.options.store.due(nowIso)) {
                    // One occurrence is retained after downtime; later missed
                    // occurrences are coalesced by calculating from `now`.
                    const next = nextOccurrence(schedule.cron, schedule.timezone, now);
                    this.options.store.planDue(
                        schedule.id,
                        schedule.nextRunAt,
                        next.toISOString(),
                        nowIso,
                    );
                }
                await this.deliverPending();
            } finally {
                this.scheduleTimer();
            }
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.timer !== undefined) {
            this.clearTimer(this.timer);
            this.timer = undefined;
        }
        await this.queue;
    }

    private requireSchedule(id: string): ScheduleDefinition {
        const schedule = this.options.store.get(id);
        if (schedule === undefined) throw new Error(`unknown schedule ${id}`);
        return schedule;
    }

    private async deliverPending(): Promise<void> {
        for (const run of this.options.store.pendingRuns()) {
            const result = await this.options.emit(
                occurrenceKey(run),
                triggerEntry(run),
            );
            this.options.store.markEmitted(
                run.scheduleId,
                run.scheduledFor,
                result.entry.seq,
                this.clock().toISOString(),
            );
        }
    }

    private scheduleTimer(): void {
        if (this.closed || this.options.autoStart === false) return;
        if (this.timer !== undefined) this.clearTimer(this.timer);
        if (this.options.store.pendingRuns().length > 0) {
            this.timer = this.setTimer(() => {
                this.timer = undefined;
                void this.runDue().catch((error) => this.options.onError?.(error));
            }, PENDING_RETRY_MS);
            return;
        }
        const next = this.options.store.nextDueAt();
        if (next === null) {
            this.timer = undefined;
            return;
        }
        const delay = Math.min(
            MAX_TIMER_MS,
            Math.max(0, Date.parse(next) - this.clock().getTime()),
        );
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            void this.runDue().catch((error) => this.options.onError?.(error));
        }, delay);
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const result = this.queue.then(task);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}

export async function startSchedulerRuntime(
    options: SchedulerRuntimeOptions,
): Promise<SchedulerRuntime> {
    const runtime = new SchedulerRuntime(options);
    await runtime.start();
    return runtime;
}

export function nextOccurrence(
    expression: string,
    timezone: string,
    after: Date,
): Date {
    if (expression.trim().split(/\s+/).length !== 5) {
        throw new Error("schedule cron must contain exactly five fields");
    }
    if (timezone.trim().length === 0) {
        throw new Error("schedule timezone cannot be empty");
    }
    let next: Date | null;
    try {
        next = new Cron(expression, {
            timezone,
            mode: "5-part",
            paused: true,
        }).nextRun(after);
    } catch (error) {
        throw new Error(
            `invalid schedule cron or timezone: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (next === null) throw new Error("schedule cron has no future occurrence");
    return next;
}

function validateId(id: string): void {
    if (!SCHEDULE_ID.test(id)) {
        throw new Error(
            "schedule id must use lowercase letters, numbers, dot, underscore, or dash",
        );
    }
}

function validateAddress(address: string): void {
    if (address.trim().length === 0) {
        throw new Error("schedule address cannot be empty");
    }
}

function occurrenceKey(run: PendingScheduleRun): string {
    return `${run.scheduleId}/${run.scheduledFor}`;
}

function triggerEntry(run: PendingScheduleRun): InboxEntryInput {
    const payload: ScheduleTriggeredPayload = {
        version: 1,
        schedule_id: run.scheduleId,
        scheduled_for: run.scheduledFor,
        payload: JSON.parse(run.payload) as Record<string, unknown>,
    };
    return {
        source: SCHEDULER_SOURCE,
        kind: SCHEDULE_TRIGGERED_KIND,
        actor: `scheduler:${run.scheduleId}`,
        session: null,
        address: run.address,
        payload: JSON.stringify(payload),
        ts: run.scheduledFor,
    };
}

function scheduleResult(schedule: ScheduleDefinition): Record<string, unknown> {
    return {
        schedule_id: schedule.id,
        cron: schedule.cron,
        timezone: schedule.timezone,
        address: schedule.address,
        payload: JSON.parse(schedule.payload),
        next_run_at: schedule.nextRunAt,
        enabled: schedule.enabled,
        misfire_policy: "coalesce",
    };
}

function runResult(run: {
    readonly scheduledFor: string;
    readonly status: string;
    readonly inboxSeq: number | null;
}): Record<string, unknown> {
    return {
        scheduled_for: run.scheduledFor,
        status: run.status,
        inbox_message_id: run.inboxSeq,
    };
}
