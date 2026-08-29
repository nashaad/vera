/**
 * One process per worker. It holds a deadline, ticks, and sends SIGKILL.
 *
 * Run as its own program: `bun src/host/worker-supervisor.ts`. It is not a
 * library the host calls; the host spawns it and talks to it over pipes.
 *
 * The whole contract:
 *
 *   - stdin carries newline-delimited JSON from the host, and only from the
 *     host. The worker has no file descriptor to this process, which is why a
 *     worker cannot extend its own deadline: there is no channel on which to
 *     ask, not merely a rule against asking.
 *   - stdout carries newline-delimited JSON events back to the host.
 *   - At the deadline the worker is killed with SIGKILL. No SIGTERM, no grace
 *     window, no notice. A grace window is a request, and a wedged loop
 *     ignores requests.
 *   - A negative deadline means no deadline. The timer never fires; the two
 *     switches below stay armed.
 *   - stdin closing means the host is gone: kill the worker and exit, so a
 *     crashed host leaves no orphan.
 *   - The worker disappearing means this process exits.
 *
 * The deadline is absolute wall-clock milliseconds since the epoch, or
 * NO_DEADLINE. Policy
 * about how long a lease should be, and in what units it is granted, lives in
 * the host; by the time it reaches here it is one number and a clock.
 *
 * Nothing here signs, verifies, parses model output, or decides anything. A
 * reimplementation in another language has to honour the JSON above and the
 * signal below, and nothing else.
 */

import { installLiveProcess } from "../live-process.ts";

const PROTOCOL_VERSION = 1;

/** A deadline that never arrives. Any negative value behaves the same way. */
export const NO_DEADLINE = -1;

/** How often the deadline and the worker's liveness are re-checked. */
export const SUPERVISOR_TICK_MS = 100;

export type KillReason = "deadline" | "host_gone" | "requested";

export interface SupervisorOptions {
    readonly input: AsyncIterable<Uint8Array | string>;
    readonly emit: (line: string) => void;
}

interface Watched {
    readonly pid: number;
    readonly processGroup: boolean;
    readonly childProcessGroups: Set<number>;
    deadlineMs: number;
}

/**
 * Runs the supervisor until the worker is dealt with. Resolves with the
 * reason the process should exit, which the caller turns into an exit.
 */
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

    /**
     * Read through a function so the declared type survives. Assignments in
     * the reader task are invisible to control-flow analysis, which otherwise
     * concludes the worker is still unset in this loop.
     */
    const readWatched = (): Watched | null => watched;

    const alive = (pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };

    const killWorker = (target: Watched, reason: KillReason): void => {
        if (target.processGroup) {
            try {
                process.kill(-target.pid, "SIGKILL");
            } catch {
                sendSignal(target.pid);
            }
        } else {
            sendSignal(target.pid);
        }
        for (const pid of target.childProcessGroups) {
            sendSignal(-pid);
        }
        target.childProcessGroups.clear();
        send({ type: "killed", pid: target.pid, reason });
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
                deadlineMs,
                processGroup: message.process_group === true,
                childProcessGroups: new Set(),
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
                watched.childProcessGroups.add(pid);
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
                // An external SIGKILL can remove the group leader before the
                // supervisor acts. The detached group can still contain tools
                // the worker started, so reap that group before exiting.
                if (current.processGroup) {
                    sendSignal(-current.pid);
                }
                for (const pid of current.childProcessGroups) {
                    sendSignal(-pid);
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

/**
 * SIGKILL cannot be caught, blocked, or ignored, so one send is the whole
 * escalation. A failure here means the process was already gone.
 */
function sendSignal(pid: number): void {
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // Already gone.
    }
}

function asPid(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : null;
}

function asDeadline(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Splits the stream into lines and yields the objects among them. A line that
 * is not a JSON object is dropped rather than thrown: the supervisor's job is
 * to outlive bad input, not to validate the host.
 */
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
