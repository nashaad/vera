import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { veraRuntimeDirectory } from "../profile-paths.ts";

// Exit status of a TUI that asks its launcher to start the current build again.
// Distinct from HOST_STARTUP_RACE_EXIT_CODE (75), which no launcher loops on.
export const RELAUNCH_EXIT_CODE = 85;

// Set by the launcher on the TUI it runs. Its value is the launcher's pid.
export const RELAUNCH_LAUNCHER_ENV = "VERA_TUI_LAUNCHER";

// A record older than this belongs to a launch that did not happen.
export const RELAUNCH_RECORD_MAX_AGE_MS = 5 * 60 * 1000;

export interface RelaunchDraft {
    readonly text: string;
    readonly attachmentIds: readonly string[];
}

export interface RelaunchRecord {
    // Absent when the TUI had no session open (the home screen).
    readonly sessionId?: string;
    readonly draft?: RelaunchDraft;
    readonly writtenAt: string;
}

// The launcher is the parent of the TUI it runs. A value that names another
// process is ignored, so only a TUI started by its launcher relaunches.
export function launcherKeyFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    parentPid: number = process.ppid,
): string | undefined {
    const value = env[RELAUNCH_LAUNCHER_ENV];
    return value !== undefined && /^[0-9]+$/.test(value) && value === String(parentPid)
        ? value
        : undefined;
}

export function relaunchRecordPath(launcherKey: string, home?: string): string {
    return join(veraRuntimeDirectory(process.env, home), "relaunch", `${launcherKey}.json`);
}

export function writeRelaunchRecord(
    launcherKey: string,
    record: RelaunchRecord,
    home?: string,
): void {
    const path = relaunchRecordPath(launcherKey, home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
}

// Reads and removes the record for this launcher. A missing, stale or unreadable
// record yields undefined; a stale or unreadable one is removed as well.
export function takeRelaunchRecord(
    launcherKey: string,
    now: number = Date.now(),
    home?: string,
): RelaunchRecord | undefined {
    const path = relaunchRecordPath(launcherKey, home);
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
    removeQuietly(path);
    const record = parseRelaunchRecord(text);
    if (record === undefined) return undefined;
    const writtenAt = Date.parse(record.writtenAt);
    if (!Number.isFinite(writtenAt) || now - writtenAt > RELAUNCH_RECORD_MAX_AGE_MS) return undefined;
    return record;
}

function parseRelaunchRecord(text: string): RelaunchRecord | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const fields = value as Record<string, unknown>;
    if (fields.sessionId !== undefined && (typeof fields.sessionId !== "string" || fields.sessionId.length === 0)) {
        return undefined;
    }
    if (typeof fields.writtenAt !== "string") return undefined;
    const draft = parseDraft(fields.draft);
    if (fields.draft !== undefined && draft === undefined) return undefined;
    return {
        writtenAt: fields.writtenAt,
        ...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}),
        ...(draft === undefined ? {} : { draft }),
    };
}

function parseDraft(value: unknown): RelaunchDraft | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null) return undefined;
    const fields = value as Record<string, unknown>;
    if (typeof fields.text !== "string") return undefined;
    if (!Array.isArray(fields.attachmentIds)) return undefined;
    if (!fields.attachmentIds.every((id) => typeof id === "string")) return undefined;
    return { text: fields.text, attachmentIds: fields.attachmentIds as string[] };
}

function removeQuietly(path: string): void {
    try {
        unlinkSync(path);
    } catch {
    }
}
