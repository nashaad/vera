export const SCHEDULER_SOURCE = "vera.scheduler";
export const SCHEDULE_TRIGGERED_KIND = "schedule.triggered";
export const MAX_SCHEDULE_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SCHEDULE_CRON_BYTES = 256;
export const MAX_SCHEDULE_TIMEZONE_BYTES = 128;
export const MAX_SCHEDULE_ADDRESS_BYTES = 256;
export const MAX_SCHEDULE_RUN_RESULTS = 100;

export interface ScheduleDefinition {
    readonly id: string;
    readonly cron: string;
    readonly timezone: string;
    readonly address: string;
    readonly payload: string;
    readonly nextRunAt: string;
    readonly enabled: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface ScheduleRun {
    readonly scheduleId: string;
    readonly scheduledFor: string;
    readonly status: "pending" | "emitted";
    readonly inboxSeq: number | null;
    readonly createdAt: string;
    readonly emittedAt: string | null;
}

export interface EmittedScheduleRun extends ScheduleRun {
    readonly status: "emitted";
    readonly emittedAt: string;
    readonly address: string;
}

export interface PendingScheduleRun extends ScheduleRun {
    readonly status: "pending";
    readonly address: string;
    readonly payload: string;
}

export type ScheduleOperation =
    | {
        readonly action: "add";
        readonly id: string;
        readonly cron: string;
        readonly timezone: string;
        readonly address: string;
        readonly payload: Record<string, unknown>;
    }
    | { readonly action: "list" }
    | { readonly action: "show"; readonly id: string }
    | { readonly action: "pause"; readonly id: string }
    | { readonly action: "resume"; readonly id: string }
    | { readonly action: "remove"; readonly id: string }
    | { readonly action: "run"; readonly id: string };

export interface ScheduleTriggeredPayload {
    readonly version: 1;
    readonly schedule_id: string;
    readonly scheduled_for: string;
    readonly payload: Record<string, unknown>;
}
