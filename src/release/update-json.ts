import { currentReleaseBuildId } from "./layout.ts";
import type { DownloadProgress } from "./download.ts";
import { updateStatus } from "./update-status.ts";
import { formatDuration } from "./update-wait.ts";
import {
    installedRunningRelease,
    performUpdate,
    UpdateCancelled,
    type UpdateOptions,
    type UpdatePhase,
    type UpdateReport,
} from "./update.ts";

const PROGRESS_INTERVAL_MS = 250;
// The desktop stops a check after 120 s and a run after 45 min, and the shared client stops a check after 90 s.
// These stay under all three, so the command reports its own timeout before anything kills it.
export const CHECK_LIMIT_MS = 60_000;
export const RUN_LIMIT_MS = 40 * 60_000;
// The wait for busy sessions ends at the run limit, so this keeps the run's own timeout from firing first.
const RUN_LIMIT_GRACE_MS = 5_000;

class UpdateTimedOut extends Error {
    constructor(limitMs: number) {
        super(
            `The update ran longer than ${formatDuration(limitMs)}, so it was stopped before anything changed.`
            + " Run it again to continue.",
        );
        this.name = "UpdateTimedOut";
    }
}

interface JsonResult {
    readonly result: "done" | "up_to_date" | "held" | "downloaded" | "failed" | "cancelled";
    readonly version?: string;
    readonly build?: string;
    readonly message?: string;
    readonly changed: boolean;
}

// One JSON object on stdout, exit 0 even when the check itself failed.
export async function runUpdateCheckJson(options: UpdateOptions): Promise<number> {
    const write = options.output ?? ((text: string) => process.stdout.write(text));
    const limitMs = options.checkLimitMs ?? CHECK_LIMIT_MS;
    const controller = new AbortController();
    const outer = options.signal;
    const onOuterAbort = (): void => controller.abort(outer?.reason);
    if (outer?.aborted === true) onOuterAbort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(
        () => controller.abort(new Error(`The update check took longer than ${formatDuration(limitMs)}.`)),
        limitMs,
    );
    try {
        write(`${JSON.stringify(await updateStatus({ ...options, signal: controller.signal }))}\n`);
    } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onOuterAbort);
    }
    return 0;
}

// One JSON object per line: progress lines, then exactly one result line. Release notes and host messages go to stderr.
export async function runUpdateJson(options: UpdateOptions): Promise<number> {
    const controller = new AbortController();
    let switching = false;
    const cancel = (): void => {
        if (!switching) controller.abort(new UpdateCancelled());
    };
    // A reader that has gone away ends the update before the switch. Once the switch has begun the
    // client may be restarting through it, so a write error is dropped and the switch finishes.
    const closed = (): void => cancel();
    const write = guarded(
        options.output ?? ((text: string) => process.stdout.write(text)),
        closed,
    );
    const notes = guarded(
        options.errorOutput ?? ((text: string) => process.stderr.write(text)),
        closed,
    );
    const watchedStreams: NodeJS.WriteStream[] = [];
    if (options.output === undefined) watchedStreams.push(process.stdout);
    if (options.errorOutput === undefined) watchedStreams.push(process.stderr);
    for (const stream of watchedStreams) {
        survivesBrokenPipe(stream);
        stream.on("error", closed);
    }
    const emit = (value: object): void => write(`${JSON.stringify(value)}\n`);

    // Past this point the signals are still handled, and ignored: the switch runs to the end.
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    process.on("SIGHUP", cancel);
    const outer = options.signal;
    const onOuterAbort = (): void => cancel();
    if (outer?.aborted === true) cancel();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const runLimitMs = options.runLimitMs ?? RUN_LIMIT_MS;
    const deadlineAt = options.deadlineAt ?? Date.now() + runLimitMs;
    const limitTimer = setTimeout(() => {
        if (!switching) controller.abort(new UpdateTimedOut(runLimitMs));
    }, Math.max(0, deadlineAt - Date.now()) + Math.min(RUN_LIMIT_GRACE_MS, runLimitMs / 10));

    let prefix: string | undefined = options.prefix;
    let before: string | undefined;
    let json: JsonResult;
    try {
        const running = options.running ?? installedRunningRelease();
        prefix ??= running.prefix;
        before = currentReleaseBuildId(prefix);
        const report = await performUpdate({
            ...options,
            running,
            prefix,
            signal: controller.signal,
            deadlineAt,
            output: (text) => notes(text),
            errorOutput: (text) => notes(text),
            onProgress: progressLines(emit, options.onProgress),
            onPhase: (phase: UpdatePhase) => {
                if (phase.phase === "switching") switching = true;
                if (phase.phase === "checking") emit({ phase: "checking" });
                else if (phase.phase === "switching") emit({ phase: "switching" });
                else {
                    emit({
                        phase: "waiting",
                        sessions: phase.sessions,
                        waited_ms: phase.waitedMs,
                        limit_ms: phase.limitMs,
                    });
                }
                options.onPhase?.(phase);
            },
        });
        json = resultOf(report, changedSince(prefix, before));
    } catch (error) {
        const changed = prefix === undefined ? false : changedSince(prefix, before);
        const reason: unknown = controller.signal.reason;
        json = controller.signal.aborted && !switching && !(reason instanceof UpdateTimedOut)
            ? { result: "cancelled", changed }
            : { result: "failed", message: reason instanceof UpdateTimedOut ? reason.message : messageOf(error), changed };
    } finally {
        clearTimeout(limitTimer);
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
        process.off("SIGHUP", cancel);
        for (const stream of watchedStreams) stream.off("error", closed);
        outer?.removeEventListener("abort", onOuterAbort);
    }
    emit(json);
    return json.result === "failed" || json.result === "cancelled" ? 1 : 0;
}

// A failed write never throws into the update. The first failure reports a closed reader.
function guarded(write: (text: string) => void, onClosed: () => void): (text: string) => void {
    let broken = false;
    return (text) => {
        if (broken) return;
        try {
            write(text);
        } catch {
            broken = true;
            onClosed();
        }
    };
}

const guardedStreams = new WeakSet<NodeJS.WriteStream>();

// EPIPE on a pipe arrives as an asynchronous 'error' event, which ends the process when nothing listens.
function survivesBrokenPipe(stream: NodeJS.WriteStream): void {
    if (guardedStreams.has(stream)) return;
    guardedStreams.add(stream);
    stream.on("error", () => undefined);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function changedSince(prefix: string, before: string | undefined): boolean {
    return currentReleaseBuildId(prefix) !== before;
}

function resultOf(report: UpdateReport, changed: boolean): JsonResult {
    switch (report.kind) {
        case "up_to_date":
            return { result: "up_to_date", version: report.version, changed: false };
        case "checked":
            return { result: "up_to_date", version: report.runningVersion, changed: false };
        case "held":
            return { result: "held", version: report.version, build: report.buildId, message: report.message, changed: false };
        case "downloaded":
            return { result: "downloaded", version: report.version, build: report.buildId, changed: false };
        case "installed": {
            const outcome = report.outcome;
            switch (outcome.kind) {
                case "activated":
                case "updated":
                    return { result: "done", version: report.version, build: report.buildId, changed };
                case "accepted":
                    return {
                        result: "done",
                        version: report.version,
                        build: report.buildId,
                        message: `Vera ${report.version} is unpacked. The running host moves to it when its running turns end.`,
                        changed,
                    };
                case "restored":
                    return {
                        result: "failed",
                        version: report.version,
                        message: `The new host for ${report.version} did not start;`
                            + ` ${outcome.runningBuildId ?? "the previous release"} is running.`,
                        changed,
                    };
                case "no_host_started":
                case "not_moved":
                    return { result: "failed", version: report.version, message: outcome.message, changed };
            }
        }
    }
}

// Bytes and total add up across the files of one update; the total is left out until every file has declared a length.
function progressLines(
    emit: (value: object) => void,
    next: ((progress: DownloadProgress) => void) | undefined,
): (progress: DownloadProgress) => void {
    const files = new Map<string, DownloadProgress>();
    let lastAt = 0;
    return (progress) => {
        next?.(progress);
        files.set(progress.url, progress);
        const now = Date.now();
        const complete = progress.total !== undefined && progress.bytes >= progress.total;
        if (!complete && now - lastAt < PROGRESS_INTERVAL_MS) return;
        lastAt = now;
        let bytes = 0;
        let total: number | undefined = 0;
        for (const file of files.values()) {
            bytes += file.bytes;
            total = total === undefined || file.total === undefined ? undefined : total + file.total;
        }
        emit({ phase: "downloading", bytes, ...(total === undefined ? {} : { total }) });
    };
}
