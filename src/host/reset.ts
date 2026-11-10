import { existsSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { dropLiveProcessIn } from "../live-process.ts";
import { inspectHostLockFile, defaultHostLockPath } from "./lockfile.ts";
import { requestHostStop, type HostIdentity, type HostStopResult } from "./protocol.ts";
import { listAgentsThroughHost } from "./agent-list-client.ts";
import { removeUnusedSocketFile, socketFileIdentity } from "./socket-file.ts";
import { backUpResetRecords } from "./reset-backup.ts";
import {
    discoverResetProcesses,
    startsMatch,
    veraRoleOf,
    type ResetCandidate,
    type ResetDiscovery,
    type ResetProcessSystem,
} from "./reset-discovery.ts";
import type { StopWaitTarget } from "./stop-when-idle.ts";

export const RESET_CONFIRM_QUESTION = "Back up and reset? [y/N] ";

export interface ResetSystem extends ResetProcessSystem {
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
    commandOf(pid: number): string | undefined;
    wait(ms: number): Promise<void>;
}

export interface ResetOptions {
    readonly home?: string;
    readonly defaultHome?: string;
    readonly assumeYes: boolean;
}

export interface ResetDependencies {
    readonly system: ResetSystem;
    readonly confirm: (question: string) => Promise<boolean>;
    readonly output: (text: string) => void;
    readonly errorOutput: (text: string) => void;
    readonly now?: () => Date;
    readonly requestStop?: (
        socketPath: string,
        identity: Pick<HostIdentity, "pid" | "started_at">,
        onWaiting: (waiting: readonly StopWaitTarget[]) => void,
    ) => Promise<HostStopResult>;
    readonly listTurns?: (socketPath: string) => Promise<readonly { readonly name: string; readonly status: string }[]>;
    readonly termPolls?: number;
    readonly killPolls?: number;
    readonly gracefulDeadlineMs?: number;
    readonly pollMs?: number;
}

export const GRACEFUL_STOP_DEADLINE_MS = 30_000;
const DEFAULT_TERM_POLLS = 60;
const DEFAULT_KILL_POLLS = 40;
const DEFAULT_POLL_MS = 50;

const ROLE_LABEL: Record<ResetCandidate["role"], string> = {
    host: "host",
    worker: "session process",
    annex: "annex",
    supervisor: "supervisor",
    watchdog: "watchdog",
    client: "client",
};

const PROOF_LABEL: Record<ResetCandidate["proof"], string> = {
    launch_home: "launch environment names this home",
    default_home: "default home, no VERA_HOME in its environment",
    host_socket: "answers on this home's host socket",
    socket_holder: "holds a socket in this home's runtime directory",
};

export async function runHostReset(options: ResetOptions, dependencies: ResetDependencies): Promise<number> {
    const { system, output, errorOutput } = dependencies;
    const discovery = await discoverResetProcesses(system, { home: options.home, defaultHome: options.defaultHome });
    const stoppable = discovery.candidates.filter((candidate) => candidate.role !== "client");
    if (stoppable.length === 0 && discovery.candidates.length === 0 && discovery.records.length === 0
        && discovery.lock.state === "absent" && discovery.unproven.length === 0 && !hasStaleRuntimeFiles(discovery)) {
        output(`Nothing to reset: no Vera process or record belongs to ${discovery.home}.\n`);
        return 0;
    }
    output(renderPlan(discovery));
    if (discovery.unproven.length > 0) {
        for (const item of discovery.unproven) {
            errorOutput(`PID ${item.pid} could not be proven to belong to this home (${item.reason}).\n`);
        }
        errorOutput("Nothing was stopped or changed. Check those processes by hand before you reset.\n");
        return 1;
    }
    output(await renderTurns(discovery, dependencies));
    if (!options.assumeYes && !(await dependencies.confirm(RESET_CONFIRM_QUESTION))) {
        output("Vera host reset was not run.\n");
        return 0;
    }
    const backup = await backUpResetRecords(discovery, discovery.candidates, (dependencies.now ?? (() => new Date()))());
    output(`Backup: ${backup}\n`);
    const failures: string[] = [];
    const stopped = await stopProcesses(discovery, stoppable, dependencies, failures);
    if (failures.length > 0) {
        for (const failure of failures) errorOutput(`${failure}\n`);
        errorOutput("Stopped records and sockets were left in place. Run 'vera host reset' again after the process above exits.\n");
        return 1;
    }
    for (const candidate of stopped) output(`Stopped ${ROLE_LABEL[candidate.role]} PID ${candidate.pid}.\n`);
    await clearRuntime(discovery, stopped, dependencies);
    output("Removed stale sockets, session process records and the host lock. The next vera starts a fresh host.\n");
    return 0;
}

function hasStaleRuntimeFiles(discovery: ResetDiscovery): boolean {
    return existsSync(discovery.socketPath) || existsSync(join(discovery.runtime, "control.sock"));
}

function renderPlan(discovery: ResetDiscovery): string {
    const lines = [`Vera home: ${discovery.home}`];
    if (discovery.candidates.length === 0) {
        lines.push("No running Vera process belongs to this home.");
    } else {
        lines.push(`Found ${discovery.candidates.length} Vera process${discovery.candidates.length === 1 ? "" : "es"} for this home:`);
        for (const candidate of discovery.candidates) {
            const build = candidate.build === undefined ? "" : `, build ${candidate.build}`;
            const note = candidate.role === "client" ? " (attached client, left running)" : "";
            lines.push(`  ${ROLE_LABEL[candidate.role]} PID ${candidate.pid}, started ${new Date(candidate.startedAt).toISOString()}${build}${note}`);
            lines.push(`    proof: ${PROOF_LABEL[candidate.proof]}`);
        }
    }
    if (discovery.records.length > 0) {
        lines.push(`Records: ${discovery.records.map((record) => `${record.source} PID ${record.pid}`).join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
}

async function renderTurns(discovery: ResetDiscovery, dependencies: ResetDependencies): Promise<string> {
    if (discovery.hostAnswer === undefined) {
        return "Running turns: the host did not answer, so none can be read.\n";
    }
    try {
        const agents = await (dependencies.listTurns ?? defaultListTurns)(discovery.socketPath);
        const running = agents.filter((agent) => agent.status === "working" || agent.status === "waiting");
        if (running.length === 0) return "Running turns: none.\n";
        return `Running turns:\n${running.map((agent) => `  ${agent.name} (${agent.status})\n`).join("")}`;
    } catch {
        return "Running turns: could not be read from the host.\n";
    }
}

async function defaultListTurns(socketPath: string): Promise<readonly { name: string; status: string }[]> {
    return (await listAgentsThroughHost(socketPath)).map((agent) => ({ name: agent.name ?? agent.id, status: agent.status }));
}

function stillVerified(system: ResetSystem, candidate: ResetCandidate): boolean {
    if (!system.isAlive(candidate.pid)) return false;
    const startedAt = system.startedAt(candidate.pid);
    if (startedAt === undefined || !startsMatch(startedAt, new Date(candidate.startedAt).toISOString())) return false;
    const command = system.commandOf(candidate.pid);
    return command !== undefined && veraRoleOf(command) !== undefined;
}

// Returns the candidates this run ended. A candidate whose identity changed is not signalled and not counted as stopped.
async function stopProcesses(
    discovery: ResetDiscovery,
    stoppable: readonly ResetCandidate[],
    dependencies: ResetDependencies,
    failures: string[],
): Promise<ResetCandidate[]> {
    const { system } = dependencies;
    const ended: ResetCandidate[] = [];
    const host = stoppable.find((candidate) => candidate.role === "host");
    if (host !== undefined && discovery.hostAnswer !== undefined && stillVerified(system, host)) {
        const deadlineMs = dependencies.gracefulDeadlineMs ?? GRACEFUL_STOP_DEADLINE_MS;
        const outcome = await gracefulHostStop(discovery, host, dependencies, deadlineMs);
        if (outcome.type === "exited") {
            ended.push(host);
        } else {
            dependencies.output(`${outcome.reason} Falling back to SIGTERM and SIGKILL.\n`);
        }
    }
    const live = stoppable.filter((candidate) => !ended.includes(candidate) && system.isAlive(candidate.pid));
    if (live.length === 0) return ended;
    await signalAndWait(system, live, "SIGTERM", dependencies.termPolls ?? DEFAULT_TERM_POLLS, dependencies);
    const survivors = live.filter((candidate) => system.isAlive(candidate.pid) && stillVerified(system, candidate));
    await signalAndWait(system, survivors, "SIGKILL", dependencies.killPolls ?? DEFAULT_KILL_POLLS, dependencies);
    for (const candidate of live) {
        if (stillVerified(system, candidate)) failures.push(`Could not stop ${ROLE_LABEL[candidate.role]} PID ${candidate.pid}.`);
        else if (!system.isAlive(candidate.pid)) ended.push(candidate);
    }
    return ended;
}

type GracefulOutcome =
    | { readonly type: "exited" }
    | { readonly type: "fallback"; readonly reason: string };

// Anything short of the host exiting within the deadline falls back to signals.
async function gracefulHostStop(
    discovery: ResetDiscovery,
    host: ResetCandidate,
    dependencies: ResetDependencies,
    deadlineMs: number,
): Promise<GracefulOutcome> {
    const { system } = dependencies;
    const pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS;
    const seconds = Math.round(deadlineMs / 1000);
    let settled: HostStopResult | Error | undefined;
    void (dependencies.requestStop ?? defaultRequestStop)(
        discovery.socketPath,
        { pid: host.pid, started_at: discovery.hostAnswer?.started_at ?? new Date(host.startedAt).toISOString() },
        renderWaiting(dependencies),
    ).then((result) => { settled = result; }, (error: unknown) => {
        settled = error instanceof Error ? error : new Error(String(error));
    });
    for (let waited = 0; waited < deadlineMs; waited += pollMs) {
        if (!system.isAlive(host.pid)) return { type: "exited" };
        if (settled instanceof Error) {
            return { type: "fallback", reason: `The host stop request failed: ${settled.message}.` };
        }
        if (settled !== undefined && (settled.type === "refused" || settled.type === "abandoned" || settled.type === "unsupported")) {
            return { type: "fallback", reason: `The host refused the stop: ${"message" in settled ? settled.message : "it does not support stop requests"}.` };
        }
        if (settled !== undefined && (settled.type === "no_answer" || settled.type === "timed_out")) {
            return { type: "fallback", reason: "The host did not answer the stop request." };
        }
        await system.wait(pollMs);
    }
    if (!system.isAlive(host.pid)) return { type: "exited" };
    return { type: "fallback", reason: `The host did not stop within ${seconds} s.` };
}

// Re-checks identity before each signal. A candidate whose identity changed is skipped.
async function signalAndWait(
    system: ResetSystem,
    candidates: readonly ResetCandidate[],
    signal: "SIGTERM" | "SIGKILL",
    polls: number,
    dependencies: ResetDependencies,
): Promise<ResetCandidate[]> {
    for (const candidate of candidates) {
        if (!stillVerified(system, candidate)) continue;
        system.signal(candidate.pid, signal);
    }
    const pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS;
    for (let poll = 0; poll < polls; poll++) {
        if (candidates.every((candidate) => !system.isAlive(candidate.pid))) break;
        await system.wait(pollMs);
    }
    return [...candidates];
}

function renderWaiting(dependencies: ResetDependencies): (waiting: readonly StopWaitTarget[]) => void {
    return (waiting) => {
        for (const target of waiting) {
            dependencies.output(target.name === null
                ? `Waiting on ${target.session_id} (${target.status})\n`
                : `Waiting on ${target.name} (${target.session_id}, ${target.status})\n`);
        }
    };
}

function defaultRequestStop(
    socketPath: string,
    identity: Pick<HostIdentity, "pid" | "started_at">,
    onWaiting: (waiting: readonly StopWaitTarget[]) => void,
): Promise<HostStopResult> {
    return requestHostStop(socketPath, identity, onWaiting, {});
}

// A record stays while its process is still alive, so a reused pid keeps its own record.
async function clearRuntime(
    discovery: ResetDiscovery,
    stopped: readonly ResetCandidate[],
    dependencies: ResetDependencies,
): Promise<void> {
    const { system } = dependencies;
    for (const candidate of stopped) dropLiveProcessIn(discovery.home, candidate.pid);
    for (const record of discovery.workerRecords) {
        if (system.isAlive(record.pid)) continue;
        await unlink(record.path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
    const lock = await inspectHostLockFile(defaultHostLockPath(discovery.home));
    if (lock.state !== "absent") {
        const pid = lock.state === "valid" ? lock.record.pid : lock.pid;
        if (pid === undefined || !system.isAlive(pid)) {
            await unlink(defaultHostLockPath(discovery.home)).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    }
    const names = await readdir(discovery.runtime).catch(() => [] as string[]);
    for (const name of names.filter((value) => value.endsWith(".sock"))) {
        const path = join(discovery.runtime, name);
        await removeUnusedSocketFile(path, await socketFileIdentity(path));
    }
}

