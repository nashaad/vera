import type { UpdateProgress } from "../../../shared/updates.ts";
import { UPDATE_MODE_CHOICES, type UpdateModeChoice } from "../../../ui/src/protocol/updates.ts";

// The main process imports only this file from this folder; the rest runs the update command and reads the home's config,
// which stays in the task process.

export const UPDATE_TASK_SERVICE = "Vera Update";
export const UPDATE_TASK_FILE = "update.cjs";

// Most sessions and characters the window shows from one waiting line; the command may list more.
const MAX_WAIT_SESSIONS = 50;
const MAX_TEXT_CHARS = 2000;

export type UpdateCheckStatus = "up_to_date" | "available" | "downloaded" | "held" | "unavailable";
export type UpdateRunResult = "done" | "up_to_date" | "held" | "downloaded" | "failed" | "cancelled";

const CHECK_STATUSES: readonly UpdateCheckStatus[] = ["up_to_date", "available", "downloaded", "held", "unavailable"];
const RUN_RESULTS: readonly UpdateRunResult[] = ["done", "up_to_date", "held", "downloaded", "failed", "cancelled"];

export type UpdateTask =
    // Reads the mode, and asks the command only when the mode is not off and a check is due or forced.
    | {
        readonly kind: "check";
        readonly home: string;
        readonly command?: string;
        readonly lastCheckedAt?: number;
        readonly now: number;
        readonly force: boolean;
    }
    // Writes the mode when one is given, then reads it back.
    | { readonly kind: "mode"; readonly home: string; readonly mode?: UpdateModeChoice }
    | { readonly kind: "run"; readonly command: string; readonly downloadOnly: boolean };

export interface UpdateCheckAnswer {
    readonly status: UpdateCheckStatus;
    readonly currentVersion: string;
    readonly latestVersion?: string;
    readonly message?: string;
}

export interface UpdateRunAnswer {
    readonly result: UpdateRunResult;
    readonly version?: string;
    readonly message?: string;
    readonly changed: boolean;
}

export type UpdateTaskReply =
    // `check` is absent when the mode is off, no command was given, or no check was due.
    | { readonly kind: "check"; readonly mode: UpdateModeChoice; readonly intervalMs: number; readonly check?: UpdateCheckAnswer }
    // `problem` says why the mode was not saved; `mode` is then the one still in the file.
    | { readonly kind: "mode"; readonly mode: UpdateModeChoice; readonly problem?: string }
    | { readonly kind: "run"; readonly answer: UpdateRunAnswer };

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_CHARS ? value : undefined;
}

function modeOf(value: unknown): UpdateModeChoice | undefined {
    return UPDATE_MODE_CHOICES.find((mode) => mode === value);
}

function wholeNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseUpdateTask(value: unknown): UpdateTask | undefined {
    if (!isFields(value)) return undefined;
    if (value.kind === "check") {
        const home = text(value.home);
        const now = wholeNumber(value.now);
        if (home === undefined || now === undefined || typeof value.force !== "boolean") return undefined;
        const command = value.command === undefined ? undefined : text(value.command);
        const lastCheckedAt = value.lastCheckedAt === undefined ? undefined : wholeNumber(value.lastCheckedAt);
        if ((value.command !== undefined && command === undefined) || (value.lastCheckedAt !== undefined && lastCheckedAt === undefined)) return undefined;
        return {
            kind: "check",
            home,
            now,
            force: value.force,
            ...(command === undefined ? {} : { command }),
            ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
        };
    }
    if (value.kind === "mode") {
        const home = text(value.home);
        const mode = value.mode === undefined ? undefined : modeOf(value.mode);
        if (home === undefined || (value.mode !== undefined && mode === undefined)) return undefined;
        return { kind: "mode", home, ...(mode === undefined ? {} : { mode }) };
    }
    if (value.kind === "run") {
        const command = text(value.command);
        if (command === undefined || typeof value.downloadOnly !== "boolean") return undefined;
        return { kind: "run", command, downloadOnly: value.downloadOnly };
    }
    return undefined;
}

function answerOfCheck(value: unknown): UpdateCheckAnswer | undefined {
    if (!isFields(value)) return undefined;
    const status = CHECK_STATUSES.find((candidate) => candidate === value.status);
    if (status === undefined || typeof value.currentVersion !== "string") return undefined;
    if ((value.latestVersion !== undefined && typeof value.latestVersion !== "string") || (value.message !== undefined && typeof value.message !== "string")) return undefined;
    return {
        status,
        currentVersion: value.currentVersion.slice(0, MAX_TEXT_CHARS),
        ...(value.latestVersion === undefined ? {} : { latestVersion: value.latestVersion.slice(0, MAX_TEXT_CHARS) }),
        ...(value.message === undefined ? {} : { message: value.message.slice(0, MAX_TEXT_CHARS) }),
    };
}

function answerOfRun(value: unknown): UpdateRunAnswer | undefined {
    if (!isFields(value)) return undefined;
    const result = RUN_RESULTS.find((candidate) => candidate === value.result);
    if (result === undefined || typeof value.changed !== "boolean") return undefined;
    if ((value.version !== undefined && typeof value.version !== "string") || (value.message !== undefined && typeof value.message !== "string")) return undefined;
    return {
        result,
        changed: value.changed,
        ...(value.version === undefined ? {} : { version: value.version.slice(0, MAX_TEXT_CHARS) }),
        ...(value.message === undefined ? {} : { message: value.message.slice(0, MAX_TEXT_CHARS) }),
    };
}

export function parseUpdateTaskReply(value: unknown): UpdateTaskReply | undefined {
    if (!isFields(value)) return undefined;
    if (value.kind === "check") {
        const mode = modeOf(value.mode);
        const intervalMs = wholeNumber(value.intervalMs);
        if (mode === undefined || intervalMs === undefined) return undefined;
        if (value.check === undefined) return { kind: "check", mode, intervalMs };
        const check = answerOfCheck(value.check);
        return check === undefined ? undefined : { kind: "check", mode, intervalMs, check };
    }
    if (value.kind === "mode") {
        const mode = modeOf(value.mode);
        if (mode === undefined || (value.problem !== undefined && typeof value.problem !== "string")) return undefined;
        return { kind: "mode", mode, ...(value.problem === undefined ? {} : { problem: value.problem.slice(0, MAX_TEXT_CHARS) }) };
    }
    if (value.kind === "run") {
        const answer = answerOfRun(value.answer);
        return answer === undefined ? undefined : { kind: "run", answer };
    }
    return undefined;
}

// The task envelope's progress carries one string, so the update's progress travels as JSON inside it.
export function encodeUpdateProgress(progress: UpdateProgress): string {
    return JSON.stringify(progress);
}

export function parseUpdateProgress(message: string | undefined): UpdateProgress | undefined {
    if (message === undefined) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(message);
    } catch {
        return undefined;
    }
    if (!isFields(value)) return undefined;
    switch (value.phase) {
        case "checking":
            return { phase: "checking" };
        case "switching":
            return { phase: "switching" };
        case "downloading": {
            const bytes = wholeNumber(value.bytes);
            const total = value.total === undefined ? undefined : wholeNumber(value.total);
            if (bytes === undefined || (value.total !== undefined && total === undefined)) return undefined;
            return { phase: "downloading", bytes, ...(total === undefined ? {} : { total }) };
        }
        case "waiting": {
            const waitedMs = wholeNumber(value.waitedMs);
            const limitMs = wholeNumber(value.limitMs);
            if (waitedMs === undefined || limitMs === undefined || !Array.isArray(value.sessions)) return undefined;
            const sessions: Array<{ readonly id: string; readonly title: string }> = [];
            for (const item of value.sessions.slice(0, MAX_WAIT_SESSIONS)) {
                if (!isFields(item) || typeof item.id !== "string" || typeof item.title !== "string") return undefined;
                sessions.push({ id: item.id.slice(0, MAX_TEXT_CHARS), title: item.title.slice(0, MAX_TEXT_CHARS) });
            }
            return { phase: "waiting", sessions, waitedMs, limitMs };
        }
        default:
            return undefined;
    }
}
