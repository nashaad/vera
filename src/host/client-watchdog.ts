import { appendFileSync, closeSync, openSync, opendirSync, readSync, type Dir } from "node:fs";
import { join } from "node:path";
import { clientFlightPaths } from "../client-flight-paths.ts";

import {
    dropLiveProcessIn,
    liveProcessDirectoryIn,
    readLiveProcessFile,
    type LiveProcessRecord,
} from "../live-process.ts";
import { veraRuntimeDirectoryIn } from "../profile-paths.ts";
import { checkRecordIdentity, processIsAlive, type RecordIdentity } from "./process-identity.ts";
import type { HostLog } from "./host-log.ts";

const CHECK_INTERVAL_MS = 1_000;
const DISCOVERY_INTERVAL_MS = 5_000;
const STALL_AFTER_MS = 5_000;
const MAX_ENTRIES_PER_SCAN = 128;
const MAX_TRACKED_CLIENTS = 64;

interface TrackedClient {
    readonly record: LiveProcessRecord;
    readonly instanceId: string;
    readonly trackedAt: number;
    stalled: boolean;
    unavailable: boolean;
    lost: boolean;
}

export interface ClientWatchdogOptions {
    readonly now?: () => number;
    readonly isAlive?: (pid: number) => boolean;
    readonly identity?: (record: LiveProcessRecord) => RecordIdentity;
    readonly intervalMs?: number;
    readonly entriesPerScan?: number;
    readonly log?: HostLog;
}

export interface ClientWatchdog {
    scan(): void;
    close(): void;
}

export function heartbeatAge(heartbeat: string, now = Date.now()): number | undefined {
    const timestamp = Date.parse(heartbeat);
    return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : undefined;
}

export function startClientWatchdog(home: string, options: ClientWatchdogOptions = {}): ClientWatchdog {
    const liveDirectory = liveProcessDirectoryIn(home);
    const runtimeDirectory = veraRuntimeDirectoryIn(home);
    const now = options.now ?? Date.now;
    const isAlive = options.isAlive ?? processIsAlive;
    const identity = options.identity ?? checkRecordIdentity;
    const entriesPerScan = Math.max(1, Math.min(options.entriesPerScan ?? MAX_ENTRIES_PER_SCAN, MAX_ENTRIES_PER_SCAN));
    const tracked = new Map<number, TrackedClient>();
    let directory: Dir | undefined;
    let candidates: LiveProcessRecord[] = [];
    let nextDiscoveryAt = 0;
    let overCapacity = false;
    let capacityLogged = false;
    let closed = false;

    const append = (client: TrackedClient, type: string, ageMs?: number): boolean => {
        try {
            appendFileSync(clientFlightPaths(runtimeDirectory, client.instanceId).logPath, `${JSON.stringify({
                timestamp: new Date(now()).toISOString(),
                level: "debug",
                type,
                instanceId: client.instanceId,
                pid: client.record.pid,
                ...(ageMs === undefined ? {} : { ageMs }),
            })}\n`, { encoding: "utf8", mode: 0o600 });
            return true;
        } catch {
            return false;
        }
    };

    const observe = (record: LiveProcessRecord): void => {
        const instanceId = record.client_instance_id;
        if (record.kind !== "tui" || instanceId === undefined || record.runtime_dir !== runtimeDirectory) return;
        let client = tracked.get(record.pid);
        if (client !== undefined && (client.instanceId !== instanceId || client.record.started_at !== record.started_at)) {
            tracked.delete(record.pid);
            client = undefined;
        }
        const current = readLiveProcessFile(join(liveDirectory, `${record.pid}.json`));
        if (current?.client_instance_id !== instanceId || current.started_at !== record.started_at) {
            tracked.delete(record.pid);
            return;
        }
        const alive = isAlive(record.pid);
        let replaced = false;
        if (client === undefined) {
            if (alive) {
                const verdict = identity(record);
                if (verdict === "unknown") return;
                replaced = verdict === "mismatch";
            }
            if (tracked.size >= MAX_TRACKED_CLIENTS) return;
            client = {
                record, instanceId, trackedAt: now(),
                stalled: false, unavailable: false, lost: false,
            };
            tracked.set(record.pid, client);
        }
        if (!alive || replaced || client.lost) {
            const current = readLiveProcessFile(join(liveDirectory, `${record.pid}.json`));
            if (current?.client_instance_id !== instanceId || current.started_at !== record.started_at) {
                tracked.delete(record.pid);
                return;
            }
            if (!client.lost) client.lost = append(client, "client_process_lost");
            if (client.lost && (replaced || !isAlive(record.pid))) {
                try { dropLiveProcessIn(home, record.pid); } catch {}
            }
            return;
        }
        const ageMs = readHeartbeatAge(clientFlightPaths(runtimeDirectory, instanceId).heartbeatPath, now());
        if (ageMs === undefined) {
            if (!client.unavailable && now() - client.trackedAt > STALL_AFTER_MS
                && append(client, "client_heartbeat_unavailable")) client.unavailable = true;
            return;
        }
        if (ageMs <= STALL_AFTER_MS) {
            if (client.unavailable && append(client, "client_heartbeat_recovered", ageMs)) client.unavailable = false;
            if (client.stalled && append(client, "client_heartbeat_recovered", ageMs)) client.stalled = false;
        } else if (!client.stalled && append(client, "client_heartbeat_stalled", ageMs)) {
            client.stalled = true;
        }
    };

    const discover = (): void => {
        if (directory === undefined && now() < nextDiscoveryAt) return;
        try {
            if (directory === undefined) {
                directory = opendirSync(liveDirectory);
                candidates = [];
                overCapacity = false;
            }
            for (let count = 0; count < entriesPerScan; count += 1) {
                const entry = directory.readSync();
                if (entry === null) {
                    directory.closeSync();
                    directory = undefined;
                    const wanted = new Set(candidates.map((record) => record.pid));
                    for (const pid of tracked.keys()) {
                        if (!wanted.has(pid)) tracked.delete(pid);
                    }
                    if (overCapacity && !capacityLogged) {
                        options.log?.({ type: "client_watchdog_capacity_reached", cap: MAX_TRACKED_CLIENTS });
                        capacityLogged = true;
                    }
                    for (const record of candidates) {
                        const client = tracked.get(record.pid);
                        if (client !== undefined && (client.instanceId !== record.client_instance_id
                            || client.record.started_at !== record.started_at)) tracked.delete(record.pid);
                        if (!tracked.has(record.pid)) observe(record);
                    }
                    candidates = [];
                    nextDiscoveryAt = now() + DISCOVERY_INTERVAL_MS;
                    return;
                }
                if (!/^\d+\.json$/.test(entry.name)) continue;
                const record = readLiveProcessFile(join(liveDirectory, entry.name));
                if (record === undefined || entry.name !== `${record.pid}.json` || record.kind !== "tui"
                    || record.client_instance_id === undefined || record.runtime_dir !== runtimeDirectory) continue;
                candidates.push(record);
                candidates.sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at) || left.pid - right.pid);
                if (candidates.length > MAX_TRACKED_CLIENTS) {
                    candidates.pop();
                    overCapacity = true;
                }
            }
        } catch {
            try { directory?.closeSync(); } catch {}
            directory = undefined;
            candidates = [];
            nextDiscoveryAt = now() + DISCOVERY_INTERVAL_MS;
        }
    };
    const scan = (): void => {
        if (closed) return;
        discover();
        for (const client of [...tracked.values()]) observe(client.record);
    };
    scan();
    const timer = setInterval(scan, options.intervalMs ?? CHECK_INTERVAL_MS);
    timer.unref();
    return {
        scan,
        close() {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            try { directory?.closeSync(); } catch {}
            directory = undefined;
            tracked.clear();
        },
    };
}

function readHeartbeatAge(path: string, now: number): number | undefined {
    try {
        const fd = openSync(path, "r");
        try {
            const buffer = Buffer.alloc(129);
            const bytes = readSync(fd, buffer, 0, buffer.length, 0);
            return bytes === buffer.length ? undefined : heartbeatAge(buffer.toString("utf8", 0, bytes), now);
        } finally {
            closeSync(fd);
        }
    } catch {
        return undefined;
    }
}
