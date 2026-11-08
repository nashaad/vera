import { randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
    selectedVeraHome,
    veraRuntimeDirectoryIn,
} from "../profile-paths.ts";
import { readRegularFileTextSync } from "./regular-file.ts";

export const RESTART_RECORD_FORMAT_VERSION = 1;

export const MAX_RESTART_RECORDS = 500;

export type RestartCause = "stop" | "update" | "crash";

export const RESTART_CAUSES: readonly RestartCause[] = [
    "stop",
    "update",
    "crash",
];

export interface RestartRecord {
    readonly session_id: string;
    readonly cause: RestartCause;
    readonly target_build_id?: string;
    readonly at: string;
}

export function defaultRestartRecordPath(home?: string): string {
    return join(
        veraRuntimeDirectoryIn(selectedVeraHome(home)),
        "restarts",
        "restarts.jsonl",
    );
}

export function appendRestartRecord(
    record: RestartRecord,
    path: string = defaultRestartRecordPath(),
): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = openSync(path, "a", 0o600);
    try {
        writeFileSync(file, `${JSON.stringify({
            format_version: RESTART_RECORD_FORMAT_VERSION,
            ...record,
        })}\n`, "utf8");
        fsyncSync(file);
    } finally {
        closeSync(file);
    }
    trimToCap(path);
}

export function listRestartRecords(
    path: string = defaultRestartRecordPath(),
): readonly RestartRecord[] {
    return readEntries(path).flatMap((entry) =>
        entry.kind === "record" ? [entry.record] : []
    );
}

// Returns how many records were removed. Lines this build cannot read are kept as they are.
export function clearRestartRecordsForSession(
    sessionId: string,
    path: string = defaultRestartRecordPath(),
): number {
    const entries = readEntries(path);
    const kept = entries.filter((entry) =>
        entry.kind !== "record" || entry.record.session_id !== sessionId
    );
    const removed = entries.length - kept.length;
    if (removed === 0) return 0;
    rewrite(path, kept.map((entry) => entry.raw));
    return removed;
}

type LedgerEntry =
    | { readonly kind: "record"; readonly raw: string; readonly record: RestartRecord }
    | { readonly kind: "newer" | "malformed"; readonly raw: string };

function trimToCap(path: string): void {
    const entries = readEntries(path);
    if (entries.length <= MAX_RESTART_RECORDS) return;
    rewrite(
        path,
        entries.slice(entries.length - MAX_RESTART_RECORDS).map((entry) => entry.raw),
    );
}

function rewrite(path: string, lines: readonly string[]): void {
    const temporaryPath = join(dirname(path), `.restarts.${randomUUID()}.tmp`);
    const serialized = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    const file = openSync(temporaryPath, "wx", 0o600);
    try {
        writeFileSync(file, serialized, "utf8");
        fsyncSync(file);
    } finally {
        closeSync(file);
    }
    renameSync(temporaryPath, path);
}

function readEntries(path: string): LedgerEntry[] {
    if (!existsSync(path)) return [];
    let source: string;
    try {
        source = readRegularFileTextSync(path);
    } catch {
        return [];
    }
    return source
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(parseEntry);
}

function parseEntry(raw: string): LedgerEntry {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return { kind: "malformed", raw };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { kind: "malformed", raw };
    }
    const version = (value as { format_version?: unknown }).format_version;
    if (typeof version === "number" && version > RESTART_RECORD_FORMAT_VERSION) {
        return { kind: "newer", raw };
    }
    if (version !== RESTART_RECORD_FORMAT_VERSION) {
        return { kind: "malformed", raw };
    }
    const record = recordFrom(value as Record<string, unknown>);
    return record === undefined
        ? { kind: "malformed", raw }
        : { kind: "record", raw, record };
}

function recordFrom(value: Record<string, unknown>): RestartRecord | undefined {
    const { session_id, cause, target_build_id, at } = value;
    if (typeof session_id !== "string" || session_id.length === 0) return undefined;
    if (!RESTART_CAUSES.includes(cause as RestartCause)) return undefined;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
    if (target_build_id !== undefined && typeof target_build_id !== "string") {
        return undefined;
    }
    return {
        session_id,
        cause: cause as RestartCause,
        at,
        ...(target_build_id === undefined ? {} : { target_build_id }),
    };
}
