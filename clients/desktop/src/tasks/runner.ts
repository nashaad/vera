import type { TaskCancelMessage, TaskLog, TaskProgress, TaskRunMessage } from "./messages.ts";
import { cancelMessage, parseTaskOutput } from "./messages.ts";

export const TASK_TIMEOUT_MS = 60_000;
// A task that has answered may take this long to exit before the next one starts anyway.
const EXIT_GRACE_MS = 2_000;

// A transport carries messages and nothing else: the run message (and a cancel message when asked for) out, task output (already decoded) back.
// A message the transport cannot decode is delivered as `undefined`, which the runner refuses.
export interface TaskProcess<Task> {
    post(message: TaskRunMessage<Task> | TaskCancelMessage): void;
    onMessage(listener: (message: unknown) => void): void;
    onExit(listener: () => void): void;
    kill(): void;
}

export interface TaskListeners {
    onProgress?(progress: TaskProgress): void;
    onLog?(log: TaskLog): void;
    // Aborting posts a cancel message. The task decides what stopping means and still answers; the deadline still applies.
    signal?: AbortSignal;
}

interface StartedTask<Reply> {
    // Settles as soon as the answer, the failure or the deadline arrives.
    readonly reply: Promise<Reply>;
    // Settles once the process is gone, or after the grace period when it does not exit.
    readonly exited: Promise<void>;
}

// Starts a process for each task and stops it once it answers, fails or runs out of time.
export class TaskRunner<Task, Reply> {
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly start: () => TaskProcess<Task>,
        private readonly parseReply: (message: unknown) => Reply | undefined,
        private readonly timeoutMs: number = TASK_TIMEOUT_MS,
    ) {}

    // One task at a time, so two tasks never write the same files together. A caller gets its
    // answer as soon as it arrives; only the queue waits for that task's process to exit.
    run(task: Task, listeners?: TaskListeners): Promise<Reply> {
        const started = this.queue.then(() => this.runOne(task, listeners));
        this.queue = started.then((task) => task.exited, () => undefined);
        return started.then((task) => task.reply);
    }

    private runOne(task: Task, listeners: TaskListeners | undefined): StartedTask<Reply> {
        const child = this.start();
        let settleReply: ((reply: Reply) => void) | undefined;
        let failReply: ((error: Error) => void) | undefined;
        const reply = new Promise<Reply>((resolve, reject) => {
            settleReply = resolve;
            failReply = reject;
        });
        let wakeExit: (() => void) | undefined;
        const exitWait = new Promise<void>((resolveExit) => {
            wakeExit = resolveExit;
        });
        let exited = false;
        let exitSeen = false;
        let settled = false;
        const signal = listeners?.signal;
        const cancel = (): void => {
            try {
                child.post(cancelMessage());
            } catch {}
        };
        const seeExit = (): void => {
            if (exitSeen) return;
            exitSeen = true;
            wakeExit?.();
        };
        const finish = (answer: Reply | undefined, problem: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            child.kill();
            if (answer === undefined) failReply?.(new Error(problem));
            else settleReply?.(answer);
            if (exited) {
                seeExit();
                return;
            }
            // The next task starts only once this process is gone, so two never run together.
            const fallback = setTimeout(seeExit, EXIT_GRACE_MS);
            fallback.unref?.();
            void exitWait.then(() => clearTimeout(fallback));
        };
        // A listener that throws must not fail the task or reach the process that called the transport.
        const notify = (call: () => void): void => {
            try {
                call();
            } catch {}
        };
        const timer = setTimeout(() => finish(undefined, "The task did not answer in time."), this.timeoutMs);
        child.onMessage((message) => {
            if (settled) return;
            const output = parseTaskOutput(message);
            if (output === undefined) return finish(undefined, "The task sent an answer that could not be read.");
            if (output.type === "progress") notify(() => listeners?.onProgress?.({ message: output.message, increment: output.increment }));
            else if (output.type === "log") notify(() => listeners?.onLog?.({ level: output.level, text: output.text }));
            else finish(this.parseReply(output.reply), "The task sent an answer that could not be read.");
        });
        child.onExit(() => {
            exited = true;
            seeExit();
            finish(undefined, "The task stopped without answering.");
        });
        try {
            child.post({ type: "run", task });
            if (signal?.aborted === true) cancel();
            else signal?.addEventListener("abort", cancel, { once: true });
        } catch (error) {
            finish(undefined, error instanceof Error ? error.message : String(error));
        }
        return { reply, exited: exitWait };
    }
}
