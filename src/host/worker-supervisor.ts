
import { installLiveProcess, skippedProcessLine } from "../live-process.ts";
import {
    signalVerifiedProcess,
    signalVerifiedProcessGroup,
    type ProcessGroupIdentity,
    type ProcessSignalResult,
} from "../process-group.ts";

const PROTOCOL_VERSION = 1;

export const NO_DEADLINE = -1;

export const SUPERVISOR_TICK_MS = 100;

export type KillReason = "deadline" | "host_gone" | "requested";

export interface SupervisorOptions {
    readonly input: AsyncIterable<Uint8Array | string>;
    readonly emit: (line: string) => void;
}

interface Watched {
    readonly pid: number;
    readonly started_at: string;
    readonly processGroup: boolean;
    readonly childProcessGroups: Map<number, ProcessGroupIdentity>;
    deadlineMs: number;
}

export async function runSupervisor(
    options: SupervisorOptions,
): Promise<string> {
    const emit = options.emit;

    let watched: Watched | null = null;
    let finished: string | null = null;
    let hostGone = false;

    const send = (event: Record<string, unknown>): void => {
        emit(`${JSON.stringify({ v: PROTOCOL_VERSION, ...event })}\n`);
    };

    const readWatched = (): Watched | null => watched;

    const alive = (pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };

    const stop = (record: ProcessGroupIdentity, group: boolean): boolean => {
        let result: ProcessSignalResult;
        if (group) {
            const groupResult = signalVerifiedProcessGroup(record, "SIGKILL");
            if (groupResult === "sent") return true;
            result = groupResult === "not_group_leader" || groupResult === "group_unverified" || groupResult === "not_delivered"
                ? signalVerifiedProcess(record, "SIGKILL") : groupResult;
        } else {
            result = signalVerifiedProcess(record, "SIGKILL");
        }
        if (result === "sent") return true;
        if (result === "gone") return false;
        send({ type: "error", message: skippedProcessLine(record.pid, result).trimEnd() });
        return false;
    };

    const killWorker = (target: Watched, reason: KillReason): void => {
        const killed = stop(target, target.processGroup);
        for (const record of target.childProcessGroups.values()) {
            stop(record, true);
        }
        target.childProcessGroups.clear();
        if (killed) send({ type: "killed", pid: target.pid, reason });
    };

    const handle = (message: Record<string, unknown>): void => {
        const type = message.type;
        if (type === "watch") {
            if (watched !== null) {
                send({ type: "error", message: "already watching a worker" });
                return;
            }
            const pid = asPid(message.pid);
            const deadlineMs = asDeadline(message.deadline_ms);
            if (pid === null || deadlineMs === null) {
                send({ type: "error", message: "watch needs pid and deadline_ms" });
                return;
            }
            watched = {
                pid,
                started_at: typeof message.started_at === "string" ? message.started_at : "",
                deadlineMs,
                processGroup: message.process_group === true,
                childProcessGroups: new Map(),
            };
            send({ type: "watching", pid, deadline_ms: deadlineMs });
            return;
        }
        if (type === "deadline") {
            const deadlineMs = asDeadline(message.deadline_ms);
            if (watched === null || deadlineMs === null) {
                send({ type: "error", message: "deadline needs a watched worker" });
                return;
            }
            watched.deadlineMs = deadlineMs;
            send({ type: "deadline", pid: watched.pid, deadline_ms: deadlineMs });
            return;
        }
        if (type === "process_group") {
            const pid = asPid(message.pid);
            if (
                watched === null
                || pid === null
                || (message.action !== "watch" && message.action !== "forget")
            ) {
                send({
                    type: "error",
                    message: "process_group needs a watched worker, action, and pid",
                });
                return;
            }
            if (message.action === "watch") {
                watched.childProcessGroups.set(pid, {
                    pid, started_at: typeof message.started_at === "string" ? message.started_at : "",
                });
            } else {
                watched.childProcessGroups.delete(pid);
            }
            return;
        }
        if (type === "kill") {
            if (watched === null) {
                send({ type: "error", message: "kill needs a watched worker" });
                return;
            }
            killWorker(watched, "requested");
            finished = "requested";
            return;
        }
        send({ type: "error", message: `unknown message type: ${String(type)}` });
    };

    const reading = (async (): Promise<void> => {
        for await (const line of jsonLines(options.input)) {
            if (finished !== null) {
                break;
            }
            handle(line);
        }
        hostGone = true;
    })();
    reading.catch(() => {
        hostGone = true;
    });

    while (finished === null) {
        const current = readWatched();
        if (hostGone) {
            if (current !== null && alive(current.pid)) {
                killWorker(current, "host_gone");
            }
            finished = "host_gone";
            break;
        }
        if (current !== null) {
            if (current.deadlineMs >= 0 && Date.now() >= current.deadlineMs) {
                killWorker(current, "deadline");
                finished = "deadline";
                break;
            }
            if (!alive(current.pid)) {
                for (const record of current.childProcessGroups.values()) {
                    stop(record, true);
                }
                current.childProcessGroups.clear();
                send({ type: "worker_exited", pid: current.pid });
                finished = "worker_exited";
                break;
            }
        }
        await sleep(SUPERVISOR_TICK_MS);
    }

    send({ type: "exit", reason: finished });
    return finished;
}

function asPid(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : null;
}

function asDeadline(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function* jsonLines(
    input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<Record<string, unknown>> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of input) {
        buffer += typeof chunk === "string"
            ? chunk
            : decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            const parsed = parseObject(line);
            if (parsed !== null) {
                yield parsed;
            }
            index = buffer.indexOf("\n");
        }
    }
}

function parseObject(line: string): Record<string, unknown> | null {
    if (line === "") {
        return null;
    }
    try {
        const value: unknown = JSON.parse(line);
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => {
        setTimeout(resolveSleep, ms);
    });
}

if (import.meta.main) {
    installLiveProcess("supervisor");
    await runSupervisor({
        input: process.stdin,
        emit: (line) => {
            process.stdout.write(line);
        },
    });
    process.exit(0);
}
