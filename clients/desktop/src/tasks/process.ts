import { utilityProcess } from "electron";
import { join } from "node:path";

import type { TaskProcess } from "./runner.ts";

// For bundled JS tasks: utility processes cannot take stdin, so the messages travel over the parent port.
// `file` is a bundle build.ts writes beside main.js; `name` is the process name the system shows.
export function startTaskProcess<Task>(file: string, name: string): TaskProcess<Task> {
    const child = utilityProcess.fork(join(import.meta.dirname, file), [], { serviceName: name });
    return {
        post: (message) => {
            child.postMessage(message);
        },
        onMessage: (listener) => {
            child.on("message", listener);
        },
        onExit: (listener) => {
            child.on("exit", () => listener());
        },
        kill: () => {
            child.kill();
        },
    };
}
