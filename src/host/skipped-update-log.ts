import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { veraRuntimeDirectory } from "../profile-paths.ts";

const MAX_SKIPPED_UPDATE_LINES = 100;
const MAX_SKIPPED_UPDATE_LOG_BYTES = 32 * 1_024;
const SKIPPED_UPDATE_SUMMARY_BYTES = 128;
const SKIPPED_UPDATE_FLUSH_MS = 250;

interface SkippedUpdateLog {
    readonly runtimeDirectory: string;
    readonly directory: string;
    readonly path: string;
    readonly pending: string[];
    lines: number;
    suppressed: number;
    writtenSuppressed: number;
    offset: number;
    summaryOffset?: number;
    initialized: boolean;
    disabled: boolean;
    writing: boolean;
    timer?: ReturnType<typeof setTimeout>;
}

let skippedUpdateLog: SkippedUpdateLog | undefined;

export function reportSkippedUpdate(socketPath: string, kind: "unknown" | "invalid_notice", seq: number | undefined, value: unknown): void {
    try {
        const runtimeDirectory = resolve(veraRuntimeDirectory());
        if (resolve(dirname(socketPath)) !== runtimeDirectory) return;
        const log = skippedUpdateLog ??= {
            runtimeDirectory,
            directory: join(runtimeDirectory, "logs", "clients"),
            path: join(runtimeDirectory, "logs", "clients", `skipped-updates-${randomUUID()}.jsonl`),
            pending: [],
            lines: 0,
            suppressed: 0,
            writtenSuppressed: 0,
            offset: 0,
            initialized: false,
            disabled: false,
            writing: false,
        };
        if (log.disabled || log.runtimeDirectory !== runtimeDirectory) return;
        if (log.lines < MAX_SKIPPED_UPDATE_LINES) {
            const rawType = asRecord(value)?.type;
            const updateType = typeof rawType === "string"
                ? rawType.slice(0, 64).replace(/[^a-zA-Z0-9_.-]/g, "_")
                : undefined;
            log.pending.push(`${JSON.stringify({ event: "skipped_agent_update", kind, seq: seq ?? null, updateType })}\n`);
            log.lines += 1;
        } else {
            log.suppressed = Math.min(Number.MAX_SAFE_INTEGER, log.suppressed + 1);
        }
        scheduleSkippedUpdateFlush(log);
    } catch {
    }
}

function scheduleSkippedUpdateFlush(log: SkippedUpdateLog): void {
    if (log.timer !== undefined || log.writing || log.disabled) return;
    log.timer = setTimeout(() => {
        log.timer = undefined;
        void flushSkippedUpdates(log);
    }, SKIPPED_UPDATE_FLUSH_MS);
    log.timer.unref();
}

async function flushSkippedUpdates(log: SkippedUpdateLog): Promise<void> {
    if (log.writing || log.disabled) return;
    log.writing = true;
    try {
        if (!log.initialized) {
            await mkdir(log.directory, { recursive: true, mode: 0o700 });
            const created = await open(log.path, "wx", 0o600);
            await created.close();
            log.initialized = true;
        }
        const file = await open(log.path, "r+");
        try {
            const lines = log.pending.splice(0).join("");
            if (lines.length > 0) {
                const bytes = Buffer.from(lines);
                if (log.offset + bytes.length + SKIPPED_UPDATE_SUMMARY_BYTES > MAX_SKIPPED_UPDATE_LOG_BYTES) {
                    throw new Error("Client diagnostic log limit reached");
                }
                await writeSkippedUpdateBytes(file, bytes, log.offset);
                log.offset += bytes.length;
            }
            const suppressed = log.suppressed;
            if (log.pending.length === 0 && suppressed > log.writtenSuppressed) {
                // Rewriting one fixed-width line keeps the count current without growing the log.
                log.summaryOffset ??= log.offset;
                const summary = JSON.stringify({ event: "skipped_agent_updates_suppressed", count: suppressed });
                const bytes = Buffer.from(`${summary.padEnd(SKIPPED_UPDATE_SUMMARY_BYTES - 1)}\n`);
                await writeSkippedUpdateBytes(file, bytes, log.summaryOffset);
                log.writtenSuppressed = suppressed;
            }
        } finally {
            await file.close();
        }
    } catch {
        log.disabled = true;
        log.pending.length = 0;
    } finally {
        log.writing = false;
        if (log.pending.length > 0 || log.suppressed > log.writtenSuppressed) {
            scheduleSkippedUpdateFlush(log);
        }
    }
}

async function writeSkippedUpdateBytes(file: Awaited<ReturnType<typeof open>>, bytes: Buffer, position: number): Promise<void> {
    let written = 0;
    while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, position + written);
        if (result.bytesWritten === 0) throw new Error("Client diagnostic write made no progress");
        written += result.bytesWritten;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
