import type { TaskLog, TaskProgress, TaskRunMessage } from "./messages.ts";
import { parseTaskOutput } from "./messages.ts";

export const TASK_TIMEOUT_MS = 60_000;

// A transport carries messages and nothing else: the run message out, task output (already decoded) back.
// A message the transport cannot decode is delivered as `undefined`, which the runner refuses.
export interface TaskProcess<Task> {
    post(message: TaskRunMessage<Task>): void;
    onMessage(listener: (message: unknown) => void): void;
    onExit(listener: () => void): void;
    kill(): void;
}

export interface TaskListeners {
    onProgress?(progress: TaskProgress): void;
    onLog?(log: TaskLog): void;
}

// Starts a process for each task and stops it once it answers, fails or runs out of time.
export class TaskRunner<Task, Reply> {
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly start: () => TaskProcess<Task>,
        private readonly parseReply: (message: unknown) => Reply | undefined,
        private readonly timeoutMs: number = TASK_TIMEOUT_MS,
    ) {}

    // One task at a time, so two tasks never write the same files together.
    run(task: Task, listeners?: TaskListeners): Promise<Reply> {
        const result = this.queue.then(() => this.runOne(task, listeners));
        this.queue = result.catch(() => undefined);
        return result;
    }

    private runOne(task: Task, listeners: TaskListeners | undefined): Promise<Reply> {
        return new Promise((resolve, reject) => {
            const child = this.start();
            let settled = false;
            const finish = (reply: Reply | undefined, problem: string): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.kill();
                if (reply === undefined) reject(new Error(problem));
                else resolve(reply);
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
            child.onExit(() => finish(undefined, "The task stopped without answering."));
            try {
                child.post({ type: "run", task });
            } catch (error) {
                finish(undefined, error instanceof Error ? error.message : String(error));
            }
        });
    }
}
