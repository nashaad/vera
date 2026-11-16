import type { SandboxViolation } from "./types.ts";
import { decodeAttribution } from "./attribution.ts";
import { classifyViolation } from "./violations.ts";

export interface SandboxLogWindow {
    readonly start: number;
    readonly end: number;
    /** srt's per-process session suffix, from a wrapped command. */
    readonly suffix: string;
}

export type SandboxLogReader = (
    window: SandboxLogWindow,
    signal: AbortSignal,
) => Promise<readonly string[]>;

export const RECOVERY_TIMEOUT_MS = 4000;
// The pass starts this long after a turn ends, so every window it queries
// (each span's end plus the slack) lies wholly in the past and a record
// written at the last moment is already visible to `log show`.
export const RECOVERY_DELAY_MS = 4000;
// One query covers at most this much time. `log show` cost follows the window:
// five minutes takes about a second and a half on an M-series Mac.
export const RECOVERY_CHUNK_MS = 5 * 60 * 1000;
// Kernel records can trail a command's exit by a moment.
export const RECOVERY_SLACK_MS = 2000;

export interface SandboxLogSpan {
    readonly start: number;
    readonly end: number;
}

export interface SandboxLogChunk extends SandboxLogSpan {
    /** Which merged span this chunk belongs to; a failed span is dropped whole. */
    readonly span: number;
}

/**
 * The chunks to query: spans closer than the slack are merged, and a span
 * longer than the chunk limit is cut. Order is preserved, so one query at a
 * time walks a turn in time order.
 */
export function logWindows(spans: readonly SandboxLogSpan[]): SandboxLogChunk[] {
    const sorted = [...spans].sort((left, right) => left.start - right.start);
    const merged: SandboxLogSpan[] = [];
    for (const span of sorted) {
        const last = merged.at(-1);
        if (
            last !== undefined
            && span.start - RECOVERY_SLACK_MS <= last.end + RECOVERY_SLACK_MS
        ) {
            merged[merged.length - 1] = {
                start: last.start,
                end: Math.max(last.end, span.end),
            };
            continue;
        }
        merged.push(span);
    }
    const windows: SandboxLogChunk[] = [];
    for (const [index, span] of merged.entries()) {
        let start = Math.max(0, span.start - RECOVERY_SLACK_MS);
        const end = span.end + RECOVERY_SLACK_MS;
        while (start < end) {
            const next = Math.min(start + RECOVERY_CHUNK_MS, end);
            windows.push({ start, end: next, span: index });
            start = next;
        }
    }
    return windows;
}

/** `log show` takes a local stamp, and the offset makes it unambiguous. */
export function logStamp(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hours = pad(Math.floor(Math.abs(offset) / 60));
    const minutes = pad(Math.abs(offset) % 60);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}${minutes}`;
}

export async function readMacOSLog(
    window: SandboxLogWindow,
    signal: AbortSignal,
): Promise<readonly string[]> {
    const child = Bun.spawn([
        "log",
        "show",
        "--style",
        "json",
        "--start",
        logStamp(window.start),
        "--end",
        logStamp(window.end),
        "--predicate",
        `eventMessage ENDSWITH "_${window.suffix}_SBX"`,
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
    const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) {
        throw new Error(error.trim() || `log show exited with ${code}`);
    }
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) {
        throw new Error("log show did not answer with a JSON array");
    }
    const messages: string[] = [];
    for (const event of parsed) {
        if (typeof event !== "object" || event === null) continue;
        const message = (event as { readonly eventMessage?: unknown }).eventMessage;
        if (typeof message === "string" && message.length > 0) {
            messages.push(message);
        }
    }
    return messages;
}

export interface RecoveredDenial {
    readonly commandId: string;
    readonly violation: SandboxViolation;
}

/** One `log show` event as a denial: the tag names the command, the first line is srt's. */
export function denialFromLogEvent(message: string): RecoveredDenial | undefined {
    const commandId = decodeAttribution(message);
    if (commandId === undefined) return undefined;
    const first = message.split("\n", 1)[0] ?? "";
    const line = first.replace(/^Sandbox:\s*/, "").trim();
    if (line.length === 0) return undefined;
    const violation = classifyViolation(line);
    if (violation.kind === "other") return undefined;
    return { commandId, violation };
}

/** Command and line, normalized, so a repeat from the log is a duplicate. */
export function violationKey(commandId: string, line: string): string {
    return `${commandId}\u0000${line.trim().replace(/\s+/g, " ")}`;
}
