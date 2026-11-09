import {
    appendFileSync,
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
} from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
    selectedVeraHome,
    veraRuntimeDirectoryIn,
} from "../profile-paths.ts";

export interface HostLogEntry extends Record<string, unknown> {
    readonly type: string;
}

export type HostLog = (entry: HostLogEntry) => void;

export function defaultHostLogPath(home?: string): string {
    return join(veraRuntimeDirectoryIn(selectedVeraHome(home)), "logs", "host.jsonl");
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

export function createAsyncHostLogger(options: HostLoggerOptions = {}): (entry: HostLogEntry) => Promise<void> {
    const path = options.path ?? defaultHostLogPath();
    const now = options.now ?? (() => new Date());
    return async (entry) => {
        try {
            const directory = dirname(path);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await chmod(directory, 0o700);
            const file = await open(path, "a", 0o600);
            try {
                await file.chmod(0o600);
                await file.writeFile(`${JSON.stringify({ timestamp: now().toISOString(), level: "debug", ...entry })}\n`, "utf8");
            } finally {
                await file.close();
            }
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
