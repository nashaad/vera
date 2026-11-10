import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { defaultVeraHomeDirectory, selectedVeraHome, veraRuntimeDirectoryIn } from "../profile-paths.ts";
import { liveProcessDirectoryIn } from "../live-process.ts";
import { type LaunchVeraHome } from "./launch-environment.ts";
import { classifyVeraProcess, START_TIME_TOLERANCE_MS } from "./process-identity.ts";
import { defaultHostLockPath, inspectHostLockFile, type HostLockInspection } from "./lockfile.ts";
import { readRecordedWorkers, type RecordedWorker } from "./pool/worker-records.ts";
import type { HostIdentity } from "./protocol.ts";

export type ResetRole = "host" | "worker" | "annex" | "supervisor" | "watchdog" | "client";
export type ResetProof = "launch_home" | "default_home" | "host_socket" | "socket_holder";

export interface ResetProcessSample {
    readonly pid: number;
    readonly command: string;
}

// Every OS read the discovery makes. Tests pass fakes; nothing here sends a signal.
export interface ResetProcessSystem {
    listProcesses(): readonly ResetProcessSample[];
    launchHome(pid: number): LaunchVeraHome;
    startedAt(pid: number): number | undefined;
    unixSocketPaths(pid: number): readonly string[];
    hostIdentity(socketPath: string): Promise<HostIdentity | undefined>;
    isAlive(pid: number): boolean;
}

export interface ResetCandidate {
    readonly pid: number;
    readonly role: ResetRole;
    readonly startedAt: number;
    readonly command: string;
    readonly proof: ResetProof;
    readonly recorded: boolean;
    readonly build?: string;
}

export interface ResetRecordedProcess {
    readonly pid: number;
    readonly startedAt: string;
    readonly source: "worker record" | "annex record" | "host lock";
}

export interface ResetDiscovery {
    readonly home: string;
    readonly runtime: string;
    readonly socketPath: string;
    readonly candidates: readonly ResetCandidate[];
    readonly hostAnswer?: HostIdentity;
    readonly lock: HostLockInspection;
    readonly records: readonly ResetRecordedProcess[];
    readonly workerRecords: readonly RecordedWorker[];
    readonly unproven: readonly { readonly pid: number; readonly reason: string }[];
}

// The home this run works on. Realpath when it exists so a symlinked home still compares equal.
export function normalizeResetHome(path: string): string {
    const absolute = resolve(path);
    try {
        return realpathSync(absolute);
    } catch {
        return absolute;
    }
}

// A Vera role is an exact argv token or a Vera entry point run under bun or node.
// Substring matches are not enough: a grep over the same text must not count.
export function veraRoleOf(command: string): ResetRole | undefined {
    const tokens = command.trim().split(/\s+/);
    const roleToken = tokens.find((token) => token.startsWith("--vera-role="));
    if (roleToken !== undefined) return roleFromArgument(roleToken.slice("--vera-role=".length));
    const executable = basename(tokens[0] ?? "");
    if (executable === "bun" || executable === "node") {
        const kind = classifyVeraProcess(command);
        if (kind === "host" || kind === "worker" || kind === "supervisor" || kind === "watchdog") return kind;
        if (kind === "client") return "client";
    }
    return undefined;
}

function roleFromArgument(value: string): ResetRole | undefined {
    if (value === "host") return "host";
    if (value === "worker" || value === "session-worker") return "worker";
    if (value === "annex") return "annex";
    if (value === "supervisor") return "supervisor";
    if (value === "watchdog") return "watchdog";
    if (value === "cli" || value === "tui") return "client";
    return undefined;
}

export function startsMatch(osStartedAt: number, recorded: string): boolean {
    const parsed = Date.parse(recorded);
    return !Number.isNaN(parsed) && Math.abs(osStartedAt - parsed) <= START_TIME_TOLERANCE_MS;
}

export async function discoverResetProcesses(
    system: ResetProcessSystem,
    options: { readonly home?: string; readonly defaultHome?: string; readonly selfPid?: number } = {},
): Promise<ResetDiscovery> {
    const home = normalizeResetHome(selectedVeraHome(options.home));
    const defaultHome = normalizeResetHome(options.defaultHome ?? defaultVeraHomeDirectory());
    const runtime = veraRuntimeDirectoryIn(home);
    const socketPath = join(runtime, "host.sock");
    const lock = await inspectHostLockFile(defaultHostLockPath(home));
    const hostAnswer = await system.hostIdentity(socketPath);
    const workerRecords = await readRecordedWorkers(home);
    const liveRecords = await readLiveRecords(home);
    const records: ResetRecordedProcess[] = [
        ...workerRecords.map((record) => ({ pid: record.pid, startedAt: record.started_at, source: "worker record" as const })),
        ...liveRecords.filter((record) => record.kind === "annex").map((record) => ({
            pid: record.pid, startedAt: record.started_at, source: "annex record" as const,
        })),
        ...(lock.state === "valid"
            ? [{ pid: lock.record.pid, startedAt: lock.record.started_at, source: "host lock" as const }]
            : []),
    ];
    const recordedPids = new Set(records.map((record) => record.pid));
    const candidates: ResetCandidate[] = [];
    const unproven: { pid: number; reason: string }[] = [];
    for (const sample of system.listProcesses()) {
        if (sample.pid === (options.selfPid ?? process.pid)) continue;
        const role = veraRoleOf(sample.command);
        if (role === undefined) continue;
        const launch = system.launchHome(sample.pid);
        let proof: ResetProof | undefined;
        if (launch.state === "set") {
            if (normalizeResetHome(launch.home) !== home) continue;
            proof = "launch_home";
        } else if (launch.state === "unset" && home === defaultHome) {
            proof = "default_home";
        } else if (hostAnswer !== undefined && hostAnswer.pid === sample.pid) {
            proof = "host_socket";
        } else if (system.unixSocketPaths(sample.pid).some((path) => path.startsWith(runtime + sep))) {
            proof = "socket_holder";
        }
        if (proof === undefined) continue;
        if (!system.isAlive(sample.pid)) continue;
        const startedAt = system.startedAt(sample.pid);
        if (startedAt === undefined) {
            unproven.push({ pid: sample.pid, reason: "its start time could not be read" });
            continue;
        }
        if (proof === "host_socket" && hostAnswer !== undefined && !startsMatch(startedAt, hostAnswer.started_at)) {
            unproven.push({ pid: sample.pid, reason: "its start time does not match the host's reply" });
            continue;
        }
        candidates.push({
            pid: sample.pid, role, startedAt, command: sample.command, proof,
            recorded: recordedPids.has(sample.pid),
            ...(hostAnswer?.pid === sample.pid && hostAnswer.build_id !== undefined ? { build: hostAnswer.build_id } : {}),
        });
    }
    if (hostAnswer !== undefined && !candidates.some((candidate) => candidate.pid === hostAnswer.pid)) {
        unproven.push({ pid: hostAnswer.pid, reason: "its host socket answers, but its command line has no Vera role" });
    }
    for (const record of records) {
        if (candidates.some((candidate) => candidate.pid === record.pid)) continue;
        if (!system.isAlive(record.pid)) continue;
        const startedAt = system.startedAt(record.pid);
        if (startedAt !== undefined && startsMatch(startedAt, record.startedAt)) {
            unproven.push({ pid: record.pid, reason: `recorded as the ${record.source} but no Vera identity proof matched` });
        }
    }
    return {
        home, runtime, socketPath, candidates, hostAnswer, lock, records,
        workerRecords,
        unproven,
    };
}

async function readLiveRecords(home: string): Promise<{ pid: number; kind: string; started_at: string }[]> {
    const directory = liveProcessDirectoryIn(home);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const records: { pid: number; kind: string; started_at: string }[] = [];
    for (const name of names.filter((value) => /^\d+\.json$/.test(value))) {
        try {
            const value = JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, unknown>;
            if (typeof value.pid === "number" && typeof value.kind === "string" && typeof value.started_at === "string") {
                records.push({ pid: value.pid, kind: value.kind, started_at: value.started_at });
            }
        } catch {
            continue;
        }
    }
    return records;
}
