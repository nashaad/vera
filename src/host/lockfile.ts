import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdir,
    open,
    readFile,
    rename,
    unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
    HOST_PROTOCOL_VERSION,
    requestHostIdentity,
    type HostIdentity,
} from "./protocol.ts";

export const HOST_LOCK_SCHEMA_VERSION = 2;

export interface HostLockRecord {
    readonly schema_version: 1 | 2;
    readonly pid: number;
    readonly started_at: string;
    readonly socket_path: string;
    /**
     * Absolute path of the entrypoint the running host was started from.
     * Absent on a version-1 record or a host that did not report one; absent
     * means unknown, not mismatched.
     */
    readonly entrypoint?: string;
}

export interface HostLockfile {
    publish(): Promise<HostLockRecord>;
    read(): Promise<HostLockRecord | undefined>;
}

export interface HostLockfileOptions {
    readonly path?: string;
    readonly socketPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly entrypoint?: string;
    readonly inspectSocket?: (
        socketPath: string,
    ) => Promise<HostIdentity | undefined>;
}

export class HostProtocolMismatchError extends Error {
    constructor(
        readonly pid: number,
        readonly actualVersion?: number,
        readonly startedAt?: string,
        readonly socketPath?: string,
    ) {
        const actual = actualVersion === undefined
            ? "a legacy protocol"
            : `protocol ${actualVersion}`;
        super(
            `Resident Vera host PID ${pid} uses ${actual}; stop it and relaunch Vera to use protocol ${HOST_PROTOCOL_VERSION}.`,
        );
        this.name = "HostProtocolMismatchError";
    }
}

export function defaultHostLockPath(): string {
    return join(homedir(), ".vera", "host.json");
}

export function defaultHostSocketPath(): string {
    return join(homedir(), ".vera", "host.sock");
}

export function createHostLockfile(
    options: HostLockfileOptions = {},
): HostLockfile {
    const path = options.path ?? defaultHostLockPath();
    const socketPath = options.socketPath ?? defaultHostSocketPath();
    const pid = options.pid ?? process.pid;
    const startedAt = options.startedAt ?? currentProcessStartedAt();
    const inspectSocket = options.inspectSocket ?? requestHostIdentity;

    return {
        async publish(): Promise<HostLockRecord> {
            if (!Number.isInteger(pid) || pid <= 0) {
                throw new Error("Host PID must be a positive integer");
            }
            if (Number.isNaN(Date.parse(startedAt))) {
                throw new Error("Host start time must be a timestamp");
            }
            const record: HostLockRecord = {
                schema_version: HOST_LOCK_SCHEMA_VERSION,
                pid,
                started_at: startedAt,
                socket_path: nonEmpty(socketPath, "host socket path"),
                ...(options.entrypoint === undefined
                    ? {}
                    : {
                        entrypoint: nonEmpty(
                            options.entrypoint,
                            "host entrypoint",
                        ),
                    }),
            };
            const serialized = `${JSON.stringify(record, null, 2)}\n`;

            const directory = dirname(path);
            const temporaryPath = join(
                directory,
                `.${basename(path)}.${randomUUID()}.tmp`,
            );
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await chmod(directory, 0o700);
            try {
                const file = await open(temporaryPath, "wx", 0o600);
                try {
                    await file.chmod(0o600);
                    await file.writeFile(serialized, "utf8");
                    await file.sync();
                } finally {
                    await file.close();
                }
                await rename(temporaryPath, path);
            } catch (error) {
                await removeFile(temporaryPath);
                throw error;
            }

            return record;
        },

        async read(): Promise<HostLockRecord | undefined> {
            const serialized = await readLockSource(path);
            if (serialized === undefined) {
                return undefined;
            }
            const record = parseHostLock(serialized);
            if (record === undefined || record.socket_path !== socketPath) {
                return undefined;
            }
            const identity = await inspectSocket(socketPath);
            if (
                identity?.pid !== record.pid
                || identity.started_at !== record.started_at
            ) {
                return undefined;
            }
            if (identity.protocol_version !== HOST_PROTOCOL_VERSION) {
                throw new HostProtocolMismatchError(
                    identity.pid,
                    identity.protocol_version,
                    identity.started_at,
                    socketPath,
                );
            }
            return record;
        },
    };
}

function currentProcessStartedAt(): string {
    return new Date(Date.now() - process.uptime() * 1_000).toISOString();
}

async function readLockSource(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) {
            return undefined;
        }
        throw error;
    }
}

async function removeFile(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error;
        }
    }
}

function parseHostLock(source: string): HostLockRecord | undefined {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
        (record.schema_version !== 1
            && record.schema_version !== HOST_LOCK_SCHEMA_VERSION)
        || !Number.isInteger(record.pid)
        || (record.pid as number) <= 0
        || typeof record.started_at !== "string"
        || Number.isNaN(Date.parse(record.started_at))
        || typeof record.socket_path !== "string"
        || record.socket_path.length === 0
        || (record.entrypoint !== undefined
            && (typeof record.entrypoint !== "string"
                || record.entrypoint.length === 0))
    ) {
        return undefined;
    }
    return record as unknown as HostLockRecord;
}

function nonEmpty(value: string, name: string): string {
    if (value.length === 0) {
        throw new Error(`${name} must not be empty`);
    }
    return value;
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}
