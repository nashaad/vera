import { logMessage, parseCancelMessage, parseRunMessage, progressMessage, resultMessage, type TaskLogLevel } from "./messages.ts";

export interface TaskReport {
    progress(message?: string, increment?: number): void;
    log(level: TaskLogLevel, text: string): void;
    // Called once if the desktop asks to cancel. A task that never asks for it is never told.
    onCancel(listener: () => void): void;
}

// One task per process. The desktop stops the process once it has the answer, so it must not exit first.
// The first message is the run message; a later cancel message reaches `report.onCancel`, and the task still answers.
export function serveOneTask<Task, Reply>(
    parse: (value: unknown) => Task | undefined,
    run: (task: Task, report: TaskReport) => Reply | Promise<Reply>,
): void {
    const cancelListeners: Array<() => void> = [];
    let cancelled = false;
    const report: TaskReport = {
        progress: (message, increment) => {
            // The desktop refuses a task whose progress it cannot read, so a bad increment is dropped here.
            const valid = increment !== undefined && Number.isFinite(increment) && increment >= 0;
            process.parentPort.postMessage(progressMessage({ message, increment: valid ? increment : undefined }));
        },
        log: (level, text) => {
            process.parentPort.postMessage(logMessage({ level, text }));
        },
        onCancel: (listener) => {
            if (cancelled) listener();
            else cancelListeners.push(listener);
        },
    };
    let started = false;
    process.parentPort.on("message", (event: { readonly data: unknown }) => {
        if (started) {
            if (parseCancelMessage(event.data) === undefined || cancelled) return;
            cancelled = true;
            for (const listener of cancelListeners.splice(0)) listener();
            return;
        }
        started = true;
        const request = parseRunMessage(event.data);
        const task = request === undefined ? undefined : parse(request.task);
        if (task === undefined) process.exit(1);
        Promise.resolve()
            .then(() => run(task, report))
            .then((reply) => process.parentPort.postMessage(resultMessage(reply)), () => process.exit(1));
    });
}
