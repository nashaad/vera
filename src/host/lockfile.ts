import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import {
    selectedVeraHome,
    veraRuntimeDirectoryIn,
} from "../profile-paths.ts";
import { checkRecordIdentity, processStartStamp } from "./process-identity.ts";
import { thisProcessBuildId } from "../release/stamp.ts";

export const HOST_LOCK_SCHEMA_VERSION = 3;

// Exit code of a host that found another host already serving; not a boot failure.
export const HOST_STARTUP_RACE_EXIT_CODE = 75;

export interface HostLockRecord {
    readonly schema_version: 1 | 2 | 3;
    readonly pid: number;
    readonly started_at: string;
    readonly socket_path: string;
    readonly build_id?: string;
    readonly project_root?: string;
    readonly role?: "host";
    readonly worker_count?: number;
    // Linux only; see processStartStamp.
    readonly start_stamp?: string;
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

export type HostLockInspection =
    | { readonly state: "absent" }
    | { readonly state: "valid"; readonly record: HostLockRecord }
    | { readonly state: "damaged"; readonly path: string; readonly pid?: number };

export function damagedLockPidMessage(pid: number, lockPath: string): string {
    return `Could not confirm PID ${pid} is the Vera host (its lockfile is`
        + " damaged)."
        + ` Check that PID ${pid} is a Vera host before you stop it. If it`
        + ` is not, deleting ${lockPath} is safe.`;
}

// Thrown when a lockfile exists but cannot be read and its PID, if any, may
// still be a running Vera host. The message names the PID when one was read.
export class HostLockUnreadableError extends Error {
    constructor(readonly lockPath: string, readonly pid?: number) {
        super(
            pid !== undefined
                ? damagedLockPidMessage(pid, lockPath)
                : `The host lockfile ${lockPath} exists but cannot be read, so Vera`
                    + " cannot tell whether a Vera host is running. Check for a"
                    + " running Vera host (vera doctor lists Vera processes). If"
                    + " there is none, delete the file.",
        );
        this.name = "HostLockUnreadableError";
    }
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
    readonly role?: "host";
    readonly workerCount?: number;
    readonly inspectSocket?: (
        socketPath: string,
    ) => Promise<HostIdentity | undefined>;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly matchesRecord?: (
        record: Pick<HostLockRecord, "pid" | "started_at">,
    ) => boolean;
    readonly readStartedAt?: (pid: number) => number | undefined;
    readonly readCommand?: (pid: number) => string | undefined;
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

export function defaultHostLockPath(home?: string): string {
    return join(veraRuntimeDirectoryIn(selectedVeraHome(home)), "host.json");
}

export function defaultHostSocketPath(home?: string): string {
    return join(veraRuntimeDirectoryIn(selectedVeraHome(home)), "host.sock");
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
    // An unreadable start time still counts as the host: the stop path
    // re-checks and refuses to signal on anything short of a match.
    const matchesRecord = options.matchesRecord
        ?? ((candidate) =>
            checkRecordIdentity(
                candidate,
                options.readStartedAt,
                options.readCommand,
            ) !== "mismatch");

    return {
        async publish(): Promise<HostLockRecord> {
            if (!Number.isInteger(pid) || pid <= 0) {
                throw new Error("Host PID must be a positive integer");
            }
            if (Number.isNaN(Date.parse(startedAt))) {
                throw new Error("Host start time must be a timestamp");
            }
            const buildId = options.buildId ?? thisProcessBuildId();
            const stamp = pid === process.pid ? processStartStamp(pid) : undefined;
            if (options.workerCount !== undefined
                && (!Number.isSafeInteger(options.workerCount) || options.workerCount < 1)) {
                throw new Error("Host session process count must be a positive integer");
            }
            const record: HostLockRecord = {
                schema_version: HOST_LOCK_SCHEMA_VERSION,
                pid,
                started_at: startedAt,
                socket_path: nonEmpty(socketPath, "host socket path"),
                build_id: nonEmpty(buildId, "host build id"),
                ...(options.projectRoot === undefined
                    ? {}
                    : { project_root: nonEmpty(options.projectRoot, "host project root") }),
                ...(options.role === undefined ? {} : { role: options.role }),
                ...(options.workerCount === undefined ? {} : { worker_count: options.workerCount }),
                ...(stamp === undefined ? {} : { start_stamp: stamp }),
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
        if (record === undefined) {
            // Reading a damaged lock as "no host" would start a second host.
            refuseDamagedHostLock(inspectLockSource(path, serialized), {
                isProcessAlive,
                readStartedAt: options.readStartedAt,
                readCommand: options.readCommand,
            });
            return {};
        }
        if (record.socket_path !== socketPath) {
            return {};
        }
        const identity = await inspectSocket(socketPath);
        if (identity === undefined) {
            const wedged = isProcessAlive(record.pid)
                && matchesRecord(record);
            return wedged ? { record, wedged: true } : {};
        }
        const startTimeUnreadable = Number.isNaN(Date.parse(record.started_at));
        if (
            identity.pid !== record.pid
            || (!startTimeUnreadable
                && identity.started_at !== record.started_at)
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
        // The answering host supplies the start time the file lacks.
        return startTimeUnreadable
            ? { record: { ...record, started_at: identity.started_at } }
            : { record };
    }
}

export interface DamagedLockProbe {
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly readStartedAt?: ((pid: number) => number | undefined) | undefined;
    readonly readCommand?: ((pid: number) => string | undefined) | undefined;
}

// A damaged lock stands for a host unless its PID is gone or provably not
// Vera. A lock with no readable PID is never ruled out.
export function damagedLockMayHoldHost(
    inspection: Extract<HostLockInspection, { state: "damaged" }>,
    probe: DamagedLockProbe = {},
): boolean {
    const pid = inspection.pid;
    if (pid === undefined) return true;
    const isAlive = probe.isProcessAlive ?? processIsAlive;
    if (!isAlive(pid)) return false;
    return checkRecordIdentity(
        { pid, started_at: "" },
        probe.readStartedAt,
        probe.readCommand,
    ) !== "mismatch";
}

// For readers that would start, replace or stop a host: they must not treat
// a damaged lock that may hold a host as "no host".
export function refuseDamagedHostLock(
    inspection: HostLockInspection,
    probe: DamagedLockProbe = {},
): void {
    if (
        inspection.state === "damaged"
        && damagedLockMayHoldHost(inspection, probe)
    ) {
        throw new HostLockUnreadableError(inspection.path, inspection.pid);
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

// A lockfile that exists but does not parse as a whole is damaged, not
// absent. Its PID, when still readable, lets the stop paths check the process.
export async function inspectHostLockFile(
    path: string = defaultHostLockPath(),
): Promise<HostLockInspection> {
    return inspectLockSource(path, await readLockSource(path));
}

// For callers that cannot be async, such as release reference checks.
export function inspectHostLockFileSync(
    path: string = defaultHostLockPath(),
): HostLockInspection {
    let serialized: string | undefined;
    try {
        serialized = readFileSync(path, "utf8");
    } catch (error) {
        if (!isMissingFileError(error)) throw error;
    }
    return inspectLockSource(path, serialized);
}

function inspectLockSource(
    path: string,
    serialized: string | undefined,
): HostLockInspection {
    if (serialized === undefined) return { state: "absent" };
    const record = parseHostLock(serialized);
    if (record !== undefined) return { state: "valid", record };
    const pid = salvageLockPid(serialized);
    return pid === undefined
        ? { state: "damaged", path }
        : { state: "damaged", path, pid };
}

function salvageLockPid(source: string): number | undefined {
    let candidate: unknown;
    try {
        const value: unknown = JSON.parse(source);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return undefined;
        }
        candidate = (value as Record<string, unknown>).pid;
    } catch {
        // Cut-off JSON: accept a number only when a delimiter follows it, so
        // a PID truncated mid-digits is not mistaken for another process.
        const match = /"pid"\s*:\s*(\d+)\s*[,}]/.exec(source);
        candidate = match === null ? undefined : Number(match[1]);
    }
    return typeof candidate === "number" && Number.isSafeInteger(candidate)
        && candidate > 0
        ? candidate
        : undefined;
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
        || (record.role !== undefined && record.role !== "host")
        || (record.worker_count !== undefined
            && (!Number.isSafeInteger(record.worker_count) || (record.worker_count as number) < 1))
    ) {
        return undefined;
    }
    return {
        schema_version: record.schema_version as 1 | 2 | 3,
        pid: record.pid as number,
        // A start time that is not a valid time stays in the record so the
        // identity check, not the parser, decides whether the lock is stale.
        started_at: typeof record.started_at === "string"
            ? record.started_at
            : "",
        socket_path: record.socket_path as string,
        ...(typeof record.build_id === "string" && record.build_id.length > 0
            ? { build_id: record.build_id }
            : {}),
        ...(typeof record.project_root === "string"
            && record.project_root.length > 0
            ? { project_root: record.project_root }
            : {}),
        ...(record.role === "host" ? { role: "host" as const } : {}),
        ...(typeof record.worker_count === "number" ? { worker_count: record.worker_count } : {}),
        ...(typeof record.start_stamp === "string" && record.start_stamp.length > 0 ? { start_stamp: record.start_stamp } : {}),
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
