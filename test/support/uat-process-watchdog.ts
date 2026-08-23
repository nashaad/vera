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
import { killTmuxServer } from "./kill-tmux-server.ts";

const CLEANUP_ATTEMPTS_MS = [0, 100, 500, 1_500, 3_000] as const;
const FORCE_AFTER_MS = 500;

if (import.meta.main) {
    const [manifestPath] = process.argv.slice(2);
    if (manifestPath === undefined) process.exit(2);
    const first = readManifest(manifestPath);
    if (first === undefined) process.exit(2);

    // EOF catches exit, crash, and SIGKILL. Heartbeat expiry catches a live
    // controller whose event loop wedged and can no longer renew its lease.
    const leaseEnd = await waitForLeaseEnd(first.heartbeat_timeout_ms);

    const signaledAt = new Map<string, number>();
    let previousAttempt = 0;
    for (const attemptAt of CLEANUP_ATTEMPTS_MS) {
        await Bun.sleep(attemptAt - previousAttempt);
        previousAttempt = attemptAt;
        const manifest = readManifest(manifestPath) ?? first;
        for (const resource of manifest.resources) {
            cleanResource(resource, signaledAt, Date.now());
        }
        if (leaseEnd === "expired") {
            stopProcess(manifest.owner, signaledAt, Date.now());
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
        killTmuxServer(resource.name);
        return;
    }
    const record = readHostRecord(resource.path);
    if (record !== undefined) stopProcess(record, signaledAt, now);
}

async function waitForLeaseEnd(
    timeoutMs: number,
): Promise<"closed" | "expired"> {
    const reader = Bun.stdin.stream().getReader();
    while (true) {
        const outcome = await readLeaseChunk(reader, timeoutMs);
        if (outcome === "heartbeat") continue;
        if (outcome === "expired") await reader.cancel().catch(() => undefined);
        return outcome;
    }
}

async function readLeaseChunk(
    reader: {
        read(): Promise<{ readonly done: boolean }>;
    },
    timeoutMs: number,
): Promise<"heartbeat" | "closed" | "expired"> {
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (outcome: "heartbeat" | "closed" | "expired"): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(outcome);
        };
        const timeout = setTimeout(() => finish("expired"), timeoutMs);
        void reader.read().then(
            (result) => finish(result.done ? "closed" : "heartbeat"),
            () => finish("closed"),
        );
    });
}

function stopProcess(
    record: { readonly pid: number; readonly started_at: string },
    signaledAt: Map<string, number>,
    now: number,
): void {
    const alive = processIsAlive(record.pid);
    const matches = recordMatchesRunningProcess(record);
    if (!alive || !matches) {
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
        || !positiveInteger(manifest.heartbeat_timeout_ms)
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
    return resource.kind === "host_lock"
        && typeof resource.path === "string"
        && resource.path.length > 0;
}

function positiveInteger(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) > 0;
}
