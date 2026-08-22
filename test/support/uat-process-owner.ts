import {
    chmodSync,
    mkdtempSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export const UAT_OWNER_SCHEMA_VERSION = 2;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

export type OwnedUatResource =
    | { readonly kind: "tmux_name"; readonly name: string }
    | { readonly kind: "host_lock"; readonly path: string };

export interface UatOwnerManifest {
    readonly schema_version: typeof UAT_OWNER_SCHEMA_VERSION;
    readonly heartbeat_timeout_ms: number;
    readonly owner: {
        readonly pid: number;
        readonly started_at: string;
    };
    readonly resources: readonly OwnedUatResource[];
}

interface UatOwnerState {
    readonly directory: string;
    readonly manifestPath: string;
    readonly owner: UatOwnerManifest["owner"];
    readonly resources: Map<string, OwnedUatResource>;
    readonly heartbeatTimeoutMs: number;
    readonly watchdogPid: number;
    /** Holds the heartbeat pipe open until this controller exits. */
    readonly watchdog: ChildProcess;
    readonly heartbeat: ReturnType<typeof setInterval>;
}

let state: UatOwnerState | undefined;
let heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
let heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS;

/** Gives the lifecycle regression a short lease without slowing real suites. */
export function configureUatOwnerLeaseForTest(options: {
    readonly heartbeatIntervalMs: number;
    readonly heartbeatTimeoutMs: number;
}): void {
    if (state !== undefined) {
        throw new Error("The UAT owner lease is already active");
    }
    if (
        !positiveInteger(options.heartbeatIntervalMs)
        || !positiveInteger(options.heartbeatTimeoutMs)
        || options.heartbeatIntervalMs >= options.heartbeatTimeoutMs
    ) {
        throw new Error(
            "The UAT heartbeat interval must be positive and shorter than its timeout",
        );
    }
    heartbeatIntervalMs = options.heartbeatIntervalMs;
    heartbeatTimeoutMs = options.heartbeatTimeoutMs;
}

/**
 * Makes a detached tmux server part of this test controller's lifetime.
 * Register before `tmux new-session`: if the controller dies after the server
 * is created, the independent watchdog has already learned its exact name.
 */
export function ownTmuxServer(name: string): void {
    register({ kind: "tmux_name", name: nonEmpty(name, "tmux socket name") });
}

/** Owns a temporary resident host through its identity-bearing lock record. */
export function ownVeraHostLock(path: string): void {
    register({ kind: "host_lock", path: nonEmpty(path, "host lock path") });
}

/** Exposed only so the lifecycle regression can prove the watchdog also exits. */
export function uatOwnerWatchdogPid(): number | undefined {
    return state?.watchdogPid;
}

function register(resource: OwnedUatResource): void {
    if (state === undefined) {
        state = createOwner(resource);
        return;
    }
    const current = state;
    current.resources.set(resourceKey(resource), resource);
    writeManifest(current);
}

function createOwner(firstResource: OwnedUatResource): UatOwnerState {
    const directory = mkdtempSync(join(tmpdir(), "vera-uat-owner-"));
    chmodSync(directory, 0o700);
    const manifestPath = join(directory, "manifest.json");
    const owner = {
        pid: process.pid,
        started_at: new Date(
            Date.now() - process.uptime() * 1_000,
        ).toISOString(),
    };
    const resources = new Map<string, OwnedUatResource>([
        [resourceKey(firstResource), firstResource],
    ]);
    const manifestOwner = {
        directory,
        manifestPath,
        owner,
        resources,
        heartbeatTimeoutMs,
    };
    // The first ownership fact reaches disk before the watchdog starts. A
    // crash before spawn can leave only this private directory, not a child.
    writeManifest(manifestOwner);
    const watchdog = spawn(process.execPath, [
        join(import.meta.dir, "uat-process-watchdog.ts"),
        manifestPath,
    ], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
    });
    if (watchdog.pid === undefined || watchdog.stdin === null) {
        throw new Error("Could not start the UAT owner watchdog");
    }
    const heartbeat = setInterval(() => {
        if (!watchdog.stdin?.destroyed) watchdog.stdin?.write("heartbeat\n");
    }, heartbeatIntervalMs);
    const stopHeartbeat = (): void => clearInterval(heartbeat);
    watchdog.stdin.on("error", stopHeartbeat);
    watchdog.once("exit", stopHeartbeat);
    watchdog.stdin.write("heartbeat\n");
    heartbeat.unref();
    watchdog.unref();
    const unrefStdin = Reflect.get(watchdog.stdin, "unref");
    if (typeof unrefStdin === "function") unrefStdin.call(watchdog.stdin);
    return {
        directory,
        manifestPath,
        owner,
        resources,
        heartbeatTimeoutMs,
        watchdogPid: watchdog.pid,
        watchdog,
        heartbeat,
    };
}

function writeManifest(
    owner: Pick<
        UatOwnerState,
        | "directory"
        | "manifestPath"
        | "owner"
        | "resources"
        | "heartbeatTimeoutMs"
    >,
): void {
    const manifest: UatOwnerManifest = {
        schema_version: UAT_OWNER_SCHEMA_VERSION,
        heartbeat_timeout_ms: owner.heartbeatTimeoutMs,
        owner: owner.owner,
        resources: [...owner.resources.values()],
    };
    const temporary = join(owner.directory, `.manifest.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    renameSync(temporary, owner.manifestPath);
}

function resourceKey(resource: OwnedUatResource): string {
    if (resource.kind === "tmux_name") return `${resource.kind}:${resource.name}`;
    return `${resource.kind}:${resource.path}`;
}

function nonEmpty(value: string, label: string): string {
    if (value.length === 0) throw new Error(`${label} must not be empty`);
    return value;
}

function positiveInteger(value: number): boolean {
    return Number.isInteger(value) && value > 0;
}
