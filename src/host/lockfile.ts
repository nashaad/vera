import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdir,
    open,
    readFile,
    rename,
    unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
    HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
    HOST_PROTOCOL_VERSION,
    requestHostIdentity,
    type HostIdentity,
} from "./protocol.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";
import { recordMatchesRunningProcess } from "./process-identity.ts";
import { thisProcessBuildId } from "../release/stamp.ts";

export const HOST_LOCK_SCHEMA_VERSION = 3;

export interface HostLockRecord {
    readonly schema_version: 1 | 2 | 3;
    readonly pid: number;
    readonly started_at: string;
    readonly socket_path: string;
    readonly build_id?: string;
    readonly project_root?: string;
}

export interface HostLockfile {
    publish(): Promise<HostLockRecord>;
    read(): Promise<HostLockRecord | undefined>;
    diagnose?(): Promise<HostLockDiagnosis>;
}

export interface HostLockDiagnosis {
    readonly record?: HostLockRecord;
    readonly wedged?: boolean;
}

export class HostUnresponsiveError extends Error {
    constructor(
        readonly pid: number,
        readonly startedAt?: string,
        readonly socketPath?: string,
    ) {
        super(
            `Resident Vera host PID ${pid} is running but not responding.`,
        );
        this.name = "HostUnresponsiveError";
    }
}

export interface HostLockfileOptions {
    readonly path?: string;
    readonly socketPath?: string;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly buildId?: string;
    readonly projectRoot?: string;
    readonly inspectSocket?: (
        socketPath: string,
    ) => Promise<HostIdentity | undefined>;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly matchesRecord?: (
        record: Pick<HostLockRecord, "pid" | "started_at">,
    ) => boolean;
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

export class HostBuildMismatchError extends Error {
    constructor(
        readonly clientBuildId: string,
        readonly hostBuildId: string | undefined,
    ) {
        const host = hostBuildId === undefined
            ? "did not report a build ID"
            : `is ${hostBuildId}`;
        const stop = process.env.VERA_DEV_INSTANCE?.trim()
            ? "'bun run dev:tui --stop' in this worktree"
            : "'vera host stop'";
        super(
            `This client is ${clientBuildId}; the resident host ${host}. `
                + `They cannot attach. Stop the host with ${stop} `
                + "and start this build again.",
        );
        this.name = "HostBuildMismatchError";
    }
}

export function assertMatchingHostBuild(
    record: Pick<HostLockRecord, "build_id">,
    clientBuildId: string = thisProcessBuildId(),
): void {
    if (record.build_id !== clientBuildId) {
        throw new HostBuildMismatchError(clientBuildId, record.build_id);
    }
}

export function defaultHostLockPath(): string {
    return join(veraRuntimeDirectory(), "host.json");
}

export function defaultHostSocketPath(): string {
    return join(veraRuntimeDirectory(), "host.sock");
}

export function createHostLockfile(
    options: HostLockfileOptions = {},
): HostLockfile {
    const path = options.path ?? defaultHostLockPath();
    const socketPath = options.socketPath ?? defaultHostSocketPath();
    const pid = options.pid ?? process.pid;
    const startedAt = options.startedAt ?? currentProcessStartedAt();
    const inspectSocket = options.inspectSocket ?? requestHostIdentity;
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    const matchesRecord = options.matchesRecord ?? recordMatchesRunningProcess;

    return {
        async publish(): Promise<HostLockRecord> {
            if (!Number.isInteger(pid) || pid <= 0) {
                throw new Error("Host PID must be a positive integer");
            }
            if (Number.isNaN(Date.parse(startedAt))) {
                throw new Error("Host start time must be a timestamp");
            }
            const buildId = options.buildId ?? thisProcessBuildId();
            const record: HostLockRecord = {
                schema_version: HOST_LOCK_SCHEMA_VERSION,
                pid,
                started_at: startedAt,
                socket_path: nonEmpty(socketPath, "host socket path"),
                build_id: nonEmpty(buildId, "host build id"),
                ...(options.projectRoot === undefined
                    ? {}
                    : { project_root: nonEmpty(options.projectRoot, "host project root") }),
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
            const diagnosis = await diagnose();
            return diagnosis.wedged === true ? undefined : diagnosis.record;
        },

        diagnose,
    };

    async function diagnose(): Promise<HostLockDiagnosis> {
        const serialized = await readLockSource(path);
        if (serialized === undefined) {
            return {};
        }
        const record = parseHostLock(serialized);
        if (record === undefined || record.socket_path !== socketPath) {
            return {};
        }
        const identity = await inspectSocket(socketPath);
        if (identity === undefined) {
            const wedged = isProcessAlive(record.pid)
                && matchesRecord(record);
            return wedged ? { record, wedged: true } : {};
        }
        if (
            identity.pid !== record.pid
            || identity.started_at !== record.started_at
        ) {
            return {};
        }
        if (!isCompatibleHostProtocol(identity)) {
            throw new HostProtocolMismatchError(
                identity.pid,
                identity.protocol_version,
                identity.started_at,
                socketPath,
            );
        }
        return { record };
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export async function readHostLockRecordFile(
    path: string = defaultHostLockPath(),
): Promise<HostLockRecord | undefined> {
    const serialized = await readLockSource(path);
    if (serialized === undefined) return undefined;
    return parseHostLock(serialized);
}

function isCompatibleHostProtocol(identity: HostIdentity): boolean {
    const version = identity.protocol_version;
    if (version === undefined) {
        return false;
    }
    if (version <= HOST_PROTOCOL_VERSION) {
        return version >= HOST_MIN_COMPATIBLE_PROTOCOL_VERSION;
    }
    return identity.minimum_compatible_protocol_version !== undefined
        && identity.minimum_compatible_protocol_version
            <= HOST_PROTOCOL_VERSION;
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
            && record.schema_version !== 2
            && record.schema_version !== HOST_LOCK_SCHEMA_VERSION)
        || !Number.isInteger(record.pid)
        || (record.pid as number) <= 0
        || typeof record.started_at !== "string"
        || Number.isNaN(Date.parse(record.started_at))
        || typeof record.socket_path !== "string"
        || record.socket_path.length === 0
        || (record.build_id !== undefined
            && (typeof record.build_id !== "string"
                || record.build_id.length === 0))
        || (record.schema_version === HOST_LOCK_SCHEMA_VERSION
            && (typeof record.build_id !== "string"
                || record.build_id.length === 0))
        || (record.project_root !== undefined
            && (typeof record.project_root !== "string"
                || record.project_root.length === 0))
    ) {
        return undefined;
    }
    return {
        schema_version: record.schema_version as 1 | 2 | 3,
        pid: record.pid as number,
        started_at: record.started_at as string,
        socket_path: record.socket_path as string,
        ...(typeof record.build_id === "string" && record.build_id.length > 0
            ? { build_id: record.build_id }
            : {}),
        ...(typeof record.project_root === "string"
            && record.project_root.length > 0
            ? { project_root: record.project_root }
            : {}),
    };
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
