// The one message format every task transport carries. All of it is plain data that survives structuredClone and JSON.
export type TaskLogLevel = "info" | "warn" | "error";

const LOG_LEVELS: readonly unknown[] = ["info", "warn", "error"];

export interface TaskRunMessage<Task> {
    readonly type: "run";
    readonly task: Task;
}

// `increment` is a percent of the whole task, as in VS Code's Progress.
export interface TaskProgress {
    readonly message?: string;
    readonly increment?: number;
}

export interface TaskLog {
    readonly level: TaskLogLevel;
    readonly text: string;
}

export interface TaskProgressMessage extends TaskProgress {
    readonly type: "progress";
}

export interface TaskLogMessage extends TaskLog {
    readonly type: "log";
}

export interface TaskResultMessage {
    readonly type: "result";
    readonly reply: unknown;
}

export type TaskOutput = TaskProgressMessage | TaskLogMessage | TaskResultMessage;

export function runMessage<Task>(task: Task): TaskRunMessage<Task> {
    return { type: "run", task };
}

export function progressMessage(progress: TaskProgress): TaskProgressMessage {
    const message: { type: "progress"; message?: string; increment?: number } = { type: "progress" };
    if (progress.message !== undefined) message.message = progress.message;
    if (progress.increment !== undefined) message.increment = progress.increment;
    return message;
}

export function logMessage(log: TaskLog): TaskLogMessage {
    return { type: "log", level: log.level, text: log.text };
}

export function resultMessage(reply: unknown): TaskResultMessage {
    return { type: "result", reply };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// Unknown keys are dropped, so a task can add fields later without failing an older desktop.
export function parseTaskOutput(value: unknown): TaskOutput | undefined {
    const fields = record(value);
    if (fields === undefined) return undefined;
    switch (fields.type) {
        case "progress": {
            const { message, increment } = fields;
            if (message !== undefined && typeof message !== "string") return undefined;
            if (increment !== undefined && !(typeof increment === "number" && Number.isFinite(increment) && increment >= 0)) return undefined;
            return progressMessage({ message, increment });
        }
        case "log": {
            const { level, text } = fields;
            if (!LOG_LEVELS.includes(level) || typeof text !== "string") return undefined;
            return logMessage({ level: level as TaskLogLevel, text });
        }
        case "result":
            return "reply" in fields ? resultMessage(fields.reply) : undefined;
        default:
            return undefined;
    }
}

export function parseRunMessage(value: unknown): TaskRunMessage<unknown> | undefined {
    const fields = record(value);
    if (fields === undefined || fields.type !== "run" || !("task" in fields)) return undefined;
    return runMessage(fields.task);
}
