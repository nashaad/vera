import {
    chmodSync,
    mkdtempSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { processStartedAt } from "../../src/host/process-identity.ts";

export const UAT_OWNER_SCHEMA_VERSION = 1;

export type OwnedUatResource =
    | { readonly kind: "tmux_name"; readonly name: string }
    | { readonly kind: "host_lock"; readonly path: string }
    | {
        readonly kind: "process";
        readonly pid: number;
        readonly started_at: string;
    };

export interface UatOwnerManifest {
    readonly schema_version: typeof UAT_OWNER_SCHEMA_VERSION;
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
    readonly watchdogPid: number;
    /** Holds the watchdog's stdin pipe open until this controller exits. */
    readonly watchdog: ChildProcess;
}

let state: UatOwnerState | undefined;

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

/** Owns a directly spawned UAT child without relying on its reusable PID. */
export function ownUatProcess(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error("Owned UAT PID must be a positive integer");
    }
    // Sandboxed runners may deny `ps`; the child has just been spawned, so the
    // registration instant is the best available identity in that case. The
    // watchdog still checks liveness and uses the OS start time whenever the
    // platform exposes it.
    const startedAt = processStartedAt(pid) ?? Date.now();
    register({
        kind: "process",
        pid,
        started_at: new Date(startedAt).toISOString(),
    });
}

/** Exposed only so the lifecycle regression can prove the watchdog also exits. */
export function uatOwnerWatchdogPid(): number | undefined {
    return state?.watchdogPid;
}

function register(resource: OwnedUatResource): void {
    const current = state ?? createOwner();
    state = current;
    current.resources.set(resourceKey(resource), resource);
    writeManifest(current);
}

function createOwner(): UatOwnerState {
    const directory = mkdtempSync(join(tmpdir(), "vera-uat-owner-"));
    chmodSync(directory, 0o700);
    const manifestPath = join(directory, "manifest.json");
    const owner = {
        pid: process.pid,
        started_at: new Date(
            Date.now() - process.uptime() * 1_000,
        ).toISOString(),
    };
    const resources = new Map<string, OwnedUatResource>();
    writeManifest({ directory, manifestPath, owner, resources });
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
    watchdog.stdin.write("owned\n");
    watchdog.unref();
    const unrefStdin = Reflect.get(watchdog.stdin, "unref");
    if (typeof unrefStdin === "function") unrefStdin.call(watchdog.stdin);
    return {
        directory,
        manifestPath,
        owner,
        resources,
        watchdogPid: watchdog.pid,
        watchdog,
    };
}

function writeManifest(
    owner: Pick<
        UatOwnerState,
        "directory" | "manifestPath" | "owner" | "resources"
    >,
): void {
    const manifest: UatOwnerManifest = {
        schema_version: UAT_OWNER_SCHEMA_VERSION,
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
    if (resource.kind === "host_lock") return `${resource.kind}:${resource.path}`;
    return `${resource.kind}:${resource.pid}:${resource.started_at}`;
}

function nonEmpty(value: string, label: string): string {
    if (value.length === 0) throw new Error(`${label} must not be empty`);
    return value;
}
