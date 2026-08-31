import { spawn } from "node:child_process";

import {
    RELEASE_SUPERVISOR_NAME,
    releaseBinaryPath,
} from "../release/layout.ts";

/**
 * The host's side of the supervisor pipe.
 *
 * Deliberately not importing the supervisor's types. The line between the two
 * is plain JSON, so this file writes literal objects and reads literal
 * objects; a supervisor rewritten as a compiled binary is a change of one
 * command here and nothing else.
 *
 * The worker is spawned elsewhere. This handle is given a pid that already
 * exists, which is what keeps renewal one-directional: the extension path runs
 * host -> supervisor over this pipe, and the worker holds no end of it.
 */

export interface SupervisorHandleOptions {
    /** The already-running worker to watch. */
    readonly pid: number;
    /** Absolute wall-clock milliseconds since the epoch. */
    readonly deadlineMs: number;
    /**
     * Kill the worker's whole process group rather than the one pid. Only
     * safe when the worker was spawned detached, so it leads its own group;
     * otherwise the negative pid would reach the host's own group.
     */
    readonly processGroup?: boolean;
    /** Command that runs the supervisor. Swap for a compiled binary. */
    readonly command?: readonly string[];
    readonly onEvent?: (event: Record<string, unknown>) => void;
}

export interface SupervisorHandle {
    readonly pid: number | null;
    /** Host-side renewal. The worker has no equivalent. */
    extendDeadline(deadlineMs: number): void;
    watchProcessGroup(pid: number): void;
    forgetProcessGroup(pid: number): void;
    killNow(): void;
    /** Drops the pipe, which the supervisor reads as the host being gone. */
    detach(): void;
    readonly exited: Promise<void>;
}

export function superviseWorker(
    options: SupervisorHandleOptions,
): SupervisorHandle {
    const command = options.command ?? [releaseBinaryPath(RELEASE_SUPERVISOR_NAME)];
    const [executable, ...args] = command;
    const child = spawn(executable as string, args, {
        argv0: "vera-supervisor",
        stdio: ["pipe", "pipe", "inherit"],
    });

    const write = (message: Record<string, unknown>): void => {
        if (child.stdin.destroyed) {
            return;
        }
        child.stdin.write(`${JSON.stringify({ v: 1, ...message })}\n`);
    };

    if (options.onEvent !== undefined) {
        readEvents(child.stdout, options.onEvent);
    }

    write({
        type: "watch",
        pid: options.pid,
        deadline_ms: options.deadlineMs,
        process_group: options.processGroup === true,
    });

    const exited = new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        child.once("error", () => resolveExit());
    });

    return {
        pid: child.pid ?? null,
        extendDeadline(deadlineMs: number): void {
            write({ type: "deadline", deadline_ms: deadlineMs });
        },
        watchProcessGroup(pid: number): void {
            write({ type: "process_group", action: "watch", pid });
        },
        forgetProcessGroup(pid: number): void {
            write({ type: "process_group", action: "forget", pid });
        },
        killNow(): void {
            write({ type: "kill" });
        },
        detach(): void {
            child.stdin.end();
        },
        exited,
    };
}

function readEvents(
    stream: NodeJS.ReadableStream,
    onEvent: (event: Record<string, unknown>) => void,
): void {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line !== "") {
                try {
                    onEvent(JSON.parse(line) as Record<string, unknown>);
                } catch {
                    // A line this side cannot parse is not worth crashing for.
                }
            }
            index = buffer.indexOf("\n");
        }
    });
}
