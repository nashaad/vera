import { spawn } from "node:child_process";

import {
    RELEASE_SUPERVISOR_NAME,
    releaseBinaryPath,
} from "../release/layout.ts";

export interface SupervisorHandleOptions {
    readonly pid: number;
    readonly deadlineMs: number;
    readonly processGroup?: boolean;
    readonly command?: readonly string[];
    readonly onEvent?: (event: Record<string, unknown>) => void;
}

export interface SupervisorHandle {
    readonly pid: number | null;
    extendDeadline(deadlineMs: number): void;
    watchProcessGroup(pid: number): void;
    forgetProcessGroup(pid: number): void;
    killNow(): void;
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
                }
            }
            index = buffer.indexOf("\n");
        }
    });
}
