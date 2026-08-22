import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import {
    recordMatchesRunningProcess,
    processIsAlive,
} from "../../src/host/process-identity.ts";
import {
    type OwnedUatResource,
    UAT_OWNER_SCHEMA_VERSION,
    type UatOwnerManifest,
} from "./uat-process-owner.ts";

const CLEANUP_ATTEMPTS_MS = [0, 100, 500, 1_500, 3_000] as const;
const FORCE_AFTER_MS = 500;

if (import.meta.main) {
    const [manifestPath] = process.argv.slice(2);
    if (manifestPath === undefined) process.exit(2);
    const first = readManifest(manifestPath);
    if (first === undefined) process.exit(2);

    // The controller owns the write end of this pipe. Kernel EOF is the lease:
    // it arrives on clean exit, crash, or SIGKILL and cannot be skipped like a
    // JavaScript `finally` block.
    for await (const _chunk of Bun.stdin.stream()) {
        // The pipe carries no messages; only its lifetime matters.
    }

    const signaledAt = new Map<string, number>();
    let previousAttempt = 0;
    for (const attemptAt of CLEANUP_ATTEMPTS_MS) {
        await Bun.sleep(attemptAt - previousAttempt);
        previousAttempt = attemptAt;
        const manifest = readManifest(manifestPath) ?? first;
        for (const resource of manifest.resources) {
            cleanResource(resource, signaledAt, Date.now());
        }
    }
    rmSync(dirname(manifestPath), { recursive: true, force: true });
}

function cleanResource(
    resource: OwnedUatResource,
    signaledAt: Map<string, number>,
    now: number,
): void {
    if (resource.kind === "tmux_name") {
        Bun.spawnSync(["tmux", "-L", resource.name, "kill-server"], {
            stdout: "ignore",
            stderr: "ignore",
        });
        return;
    }
    if (resource.kind === "host_lock") {
        const record = readHostRecord(resource.path);
        if (record !== undefined) stopProcess(record, signaledAt, now);
        return;
    }
    stopProcess(resource, signaledAt, now);
}

function stopProcess(
    record: { readonly pid: number; readonly started_at: string },
    signaledAt: Map<string, number>,
    now: number,
): void {
    if (!processIsAlive(record.pid) || !recordMatchesRunningProcess(record)) {
        return;
    }
    const key = `${record.pid}:${record.started_at}`;
    const firstSignal = signaledAt.get(key);
    const signal = firstSignal === undefined || now - firstSignal < FORCE_AFTER_MS
        ? "SIGTERM"
        : "SIGKILL";
    try {
        process.kill(record.pid, signal);
        if (firstSignal === undefined) signaledAt.set(key, now);
    } catch {
        // A process disappearing between identity check and signal is clean.
    }
}

function readManifest(path: string): UatOwnerManifest | undefined {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const manifest = value as Record<string, unknown>;
    if (
        manifest.schema_version !== UAT_OWNER_SCHEMA_VERSION
        || !validIdentity(manifest.owner)
        || !Array.isArray(manifest.resources)
        || !manifest.resources.every(validResource)
    ) return undefined;
    return manifest as unknown as UatOwnerManifest;
}

function readHostRecord(
    path: string,
): { readonly pid: number; readonly started_at: string } | undefined {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
    return validIdentity(value) ? value : undefined;
}

function validIdentity(
    value: unknown,
): value is { readonly pid: number; readonly started_at: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return Number.isInteger(record.pid)
        && (record.pid as number) > 0
        && typeof record.started_at === "string"
        && !Number.isNaN(Date.parse(record.started_at));
}

function validResource(value: unknown): value is OwnedUatResource {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const resource = value as Record<string, unknown>;
    if (resource.kind === "tmux_name") {
        return typeof resource.name === "string" && resource.name.length > 0;
    }
    if (resource.kind === "host_lock") {
        return typeof resource.path === "string" && resource.path.length > 0;
    }
    return resource.kind === "process" && validIdentity(resource);
}
