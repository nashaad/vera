import {
    appendFileSync,
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { veraRuntimeDirectory } from "../profile-paths.ts";

export interface HostLogEntry extends Record<string, unknown> {
    readonly type: string;
}

export type HostLog = (entry: HostLogEntry) => void;

export function defaultHostLogPath(): string {
    return join(veraRuntimeDirectory(), "logs", "host.jsonl");
}

export interface HostLoggerOptions {
    readonly path?: string;
    readonly now?: () => Date;
}

export function createHostLogger(options: HostLoggerOptions = {}): HostLog {
    const path = options.path ?? defaultHostLogPath();
    const now = options.now ?? (() => new Date());
    let prepared = false;
    return (entry) => {
        try {
            if (!prepared) {
                prepareHostLog(path);
                prepared = true;
            }
            appendFileSync(
                path,
                `${JSON.stringify({
                    timestamp: now().toISOString(),
                    level: "debug",
                    ...entry,
                })}\n`,
                { encoding: "utf8", mode: 0o600 },
            );
        } catch {
        }
    };
}

function prepareHostLog(path: string): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    const file = openSync(path, "a", 0o600);
    try {
        fchmodSync(file, 0o600);
    } finally {
        closeSync(file);
    }
}
