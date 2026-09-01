import { join } from "node:path";

import { listAgentPageThroughHost } from "../src/host/agent-list-client.ts";
import {
    createHostLockfile,
    readHostLockRecordFile,
} from "../src/host/lockfile.ts";
import {
    processIsAlive,
    recordMatchesRunningProcess,
} from "../src/host/process-identity.ts";
import {
    DEFAULT_PROFILE_NAME,
    VERA_HOME_ENV,
    VERA_PROFILE_ENV,
    VERA_RUNTIME_DIR_ENV,
    VERA_WORKTREE_RUNTIME_ENV,
    veraHomeDirectory,
    veraRuntimeDirectory,
} from "../src/profile-paths.ts";
import { sweepStaleTmuxSockets } from "./tmux-socket-doctor.ts";

const DEFAULT_SAMPLE_INTERVAL_MS = 750;
const DEFAULT_HIGH_CPU_PERCENT = 50;
const MAX_QUIET_UNRECOGNIZED_HOSTS = 5;

export type VeraProcessKind =
    | "host"
    | "client"
    | "watchdog"
    | "worker"
    | "supervisor"
    | "test_fixture";

export interface VeraProcessSample {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly elapsed: string;
    readonly cpuPercent: number;
    readonly startedAt: string;
    readonly command: string;
    readonly kind: VeraProcessKind;
    /**
     * Set when this process overrode the profile runtime (`VERA_RUNTIME_DIR`
     * or `VERA_HOME`). Tests and UAT use that override. A launcher-owned
     * worktree runtime carries its separate marker and is not a leftover.
     */
    readonly isolated?: boolean;
    readonly runtimeDir?: string;
    /** Deliberate linked-worktree runtime, not disposable test isolation. */
    readonly worktreeRuntime?: boolean;
}

export interface DiagnosedVeraProcess extends VeraProcessSample {
    readonly currentHost: boolean;
    readonly knownProfileHost: boolean;
    readonly sustainedHighCpu: boolean;
    /**
     * Orphaned and safe to stop without asking what it was for: a worker,
     * supervisor, or test fixture with no live parent to reclaim it, or a
     * host with neither a matching lock nor a parent shell of its own.
     */
    readonly stray: boolean;
    /** Session this worker or supervisor is running, when the host named one. */
    readonly sessionId?: string;
    readonly sessionTitle?: string;
}

export interface VeraDoctorReport {
    readonly healthy: boolean;
    readonly currentHostPid?: number;
    readonly currentHostMissing: boolean;
    readonly processes: readonly DiagnosedVeraProcess[];
    readonly highCpuPercent: number;
}

export interface VeraDoctorOptions {
    readonly readHostOwnership?: () => Promise<VeraHostOwnership>;
    readonly sampleProcesses?: () => Promise<readonly VeraProcessSample[]>;
    readonly wait?: (delayMs: number) => Promise<void>;
    readonly sampleIntervalMs?: number;
    readonly highCpuPercent?: number;
    readonly doctorPid?: number;
    /**
     * Runtime island this doctor is allowed to inspect and stop. Defaults to
     * the invoking process's runtime. Processes in any other directory are
     * foreign: listed by their own doctor, never stopped by this one.
     */
    readonly runtimeIsland?: string;
    /**
     * Running sessions from the current host listing, used to title workers.
     * Tests inject this. Live doctor reads the host when sampling real
     * processes, and skips the listing when the process table is injected.
     */
    readonly listWorkerSessions?: () => Promise<readonly VeraWorkerSession[]>;
}

/** A session the current host has actually spawned a worker for. */
export interface VeraWorkerSession {
    readonly id: string;
    readonly title?: string;
    readonly name?: string;
    readonly workerPid: number;
    readonly supervisorPid?: number;
}

export interface VeraHostOwnership {
    readonly currentHostPid?: number;
    readonly knownProfileHostPids: ReadonlySet<number>;
}

export async function diagnoseVeraProcesses(
    options: VeraDoctorOptions = {},
): Promise<VeraDoctorReport> {
    const island = options.runtimeIsland ?? veraRuntimeDirectory();
    const readHostOwnership = options.readHostOwnership
        ?? (() => hostOwnership(island));
    const sampleProcesses = options.sampleProcesses ?? sampleVeraProcesses;
    const wait = options.wait ?? waitFor;
    const interval = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    const highCpuPercent = options.highCpuPercent ?? DEFAULT_HIGH_CPU_PERCENT;
    const doctorPid = options.doctorPid ?? process.pid;
    const listWorkerSessions = options.listWorkerSessions
        ?? (options.sampleProcesses === undefined
            ? listCurrentHostWorkerSessions
            : async () => []);

    const firstSample = await sampleProcesses();
    await wait(interval);
    let secondSample = await sampleProcesses();
    let ownership = await readHostOwnership();
    if (!ownershipMatchesProcessTable(ownership, secondSample)) {
        secondSample = await sampleProcesses();
        ownership = await readHostOwnership();
    }
    const { currentHostPid, knownProfileHostPids } = ownership;
    const firstByPid = new Map(
        firstSample
            .filter((sample) => sample.pid !== doctorPid)
            .map((sample) => [sample.pid, sample]),
    );
    const annotated = secondSample
        .filter((sample) => sample.pid !== doctorPid)
        .map((sample) => {
            const currentHost = sample.kind === "host"
                && sample.pid === currentHostPid;
            const knownProfileHost = sample.kind === "host"
                && sample.pid !== currentHostPid
                && knownProfileHostPids.has(sample.pid);
            return {
                ...sample,
                currentHost,
                knownProfileHost,
                sustainedHighCpu:
                    sample.cpuPercent >= highCpuPercent
                    && sameProcessStayedAbove(
                        firstByPid.get(sample.pid),
                        sample,
                        highCpuPercent,
                    ),
            };
        });
    const host = annotated.find((sample) => sample.pid === currentHostPid);
    const tuiPid = host !== undefined && host.ppid > 1 ? host.ppid : undefined;
    const scoped = annotated.filter((sample) =>
        belongsToRuntimeIsland(sample, island, currentHostPid, tuiPid)
    );
    const strayHostPids = new Set(
        scoped
            .filter((sample) =>
                sample.kind === "host"
                && strayHost(sample)
            )
            .map((sample) => sample.pid),
    );
    const processes = withSessionLabels(
        scoped
            .map((sample): DiagnosedVeraProcess => ({
                ...sample,
                stray: strayProcess(sample, strayHostPids),
            }))
            .sort(compareProcesses),
        await listWorkerSessions(),
    );
    const currentHostMissing = currentHostPid !== undefined
        && !processes.some((sample) =>
            sample.kind === "host" && sample.pid === currentHostPid
        );
    const unrecognizedHosts = processes.filter((sample) =>
        sample.kind === "host"
        && !sample.currentHost
        && !sample.knownProfileHost
        && sample.worktreeRuntime !== true
    );
    return {
        healthy: !currentHostMissing
            && unrecognizedHosts.length === 0
            && !processes.some((sample) => sample.stray),
        ...(currentHostPid === undefined ? {} : { currentHostPid }),
        currentHostMissing,
        processes,
        highCpuPercent,
    };
}

export function renderVeraDoctor(report: VeraDoctorReport): string {
    const hosts = report.processes.filter((process) => process.kind === "host");
    const clients = report.processes.filter((process) =>
        process.kind === "client"
    );
    const strays = report.processes.filter((process) => process.stray);
    const extraHosts = hosts.filter((process) => !process.currentHost);
    const unrecognizedHosts = extraHosts.filter((process) =>
        !process.knownProfileHost
        && process.worktreeRuntime !== true
    );
    const highCpu = report.processes.filter((process) =>
        process.sustainedHighCpu
    );
    const lines = [
        "Vera doctor",
        "",
        "Process summary",
        `  Resident host: ${report.currentHostPid === undefined
            ? "not running"
            : `PID ${report.currentHostPid}`}`,
        `  Vera clients: ${clients.length}`,
    ];
    lines.push(...renderRunningNow(report.processes));
    const unrecognizedHighCpu = unrecognizedHosts.filter((candidate) =>
        candidate.sustainedHighCpu
    );
    const quietUnrecognizedHosts = unrecognizedHosts.filter((candidate) =>
        !candidate.sustainedHighCpu
    );
    const shownIssues = [
        ...unrecognizedHighCpu,
        ...quietUnrecognizedHosts.slice(0, MAX_QUIET_UNRECOGNIZED_HOSTS),
    ];

    if (!report.healthy) {
        lines.push("", "Issues");
        if (report.currentHostMissing) {
            lines.push(
                `  Resident host PID ${report.currentHostPid} was not found in the process table.`,
            );
        }
        renderProcessRows(lines, shownIssues);
    }
    // Stray hosts are already listed under Issues as unrecognized hosts;
    // workers and test fixtures have no other section, so they go here.
    const nonHostStrays = strays.filter((process) => process.kind !== "host");
    if (nonHostStrays.length > 0) {
        lines.push(
            "",
            `Stray processes: ${nonHostStrays.length} orphaned (reparented, no host or terminal left to reclaim them)`,
        );
        renderProcessRows(lines, nonHostStrays);
    }
    const hiddenQuietHosts = Math.max(
        0,
        quietUnrecognizedHosts.length - MAX_QUIET_UNRECOGNIZED_HOSTS,
    );
    if (hiddenQuietHosts > 0) {
        lines.push(
            `  ... ${hiddenQuietHosts} more unrecognized low-CPU host processes`,
        );
    }
    if (unrecognizedHosts.length > 0) {
        lines.push(
            "",
            `${unrecognizedHosts.length} host process${unrecognizedHosts.length === 1 ? " has" : "es have"} no active lock in this Vera home. Isolated tests can be legitimate; sustained CPU makes one suspicious.`,
        );
    }
    const recognizedHighCpu = highCpu.filter((process) =>
        process.kind !== "host"
        || process.currentHost
        || process.knownProfileHost
    );
    if (recognizedHighCpu.length > 0) {
        lines.push("", "High CPU activity");
        renderProcessRows(lines, recognizedHighCpu);
    }
    if (highCpu.length > 0) {
        lines.push(
            `${highCpu.length} Vera process${highCpu.length === 1 ? " stayed" : "es stayed"} at or above ${report.highCpuPercent}% CPU across both samples.`,
        );
    }
    lines.push(report.healthy ? "Result: healthy" : "Result: issues found");
    lines.push(
        strays.length > 0
            ? `${strays.length} stray process${strays.length === 1 ? "" : "es"} can be stopped safely.`
            : "No stray processes found.",
    );
    return `${lines.join("\n")}\n`;
}

/**
 * SIGKILLs each stray's process group (falling back to the bare pid), for
 * the caller to run only once the user has agreed to it.
 */
export function stopStrayVeraProcesses(
    strays: readonly DiagnosedVeraProcess[],
): number {
    let stopped = 0;
    for (const stray of strays) {
        if (killProcessAndGroup(stray.pid, stray.pgid)) stopped += 1;
    }
    return stopped;
}

/**
 * Unattended SIGKILL of leftovers. Launch must not call this. The only
 * supported path is `vera doctor` after the caller confirms, or
 * `vera doctor --yes`.
 */
export async function sweepStrayVeraProcesses(
    options: Pick<
        VeraDoctorOptions,
        "runtimeIsland" | "sampleIntervalMs" | "doctorPid"
    > = {},
): Promise<number> {
    const report = await diagnoseVeraProcesses({
        ...options,
        sampleIntervalMs: options.sampleIntervalMs ?? 0,
    });
    const strays = report.processes.filter((process) => process.stray);
    const stopped = strays.length === 0 ? 0 : stopStrayVeraProcesses(strays);
    try {
        await sweepStaleTmuxSockets();
    } catch {
        // Leftover socket files must not block a client from starting.
    }
    return stopped;
}

function killProcessAndGroup(pid: number, pgid: number): boolean {
    let signaled = false;
    if (pgid === pid) {
        try {
            process.kill(-pgid, "SIGKILL");
            signaled = true;
        } catch {
            // Not a group leader after all, or already gone.
        }
    }
    try {
        process.kill(pid, "SIGKILL");
        signaled = true;
    } catch {
        // Already gone, which still counts if the group signal above landed.
    }
    return signaled;
}

export function parseVeraProcessList(source: string): VeraProcessSample[] {
    const samples: VeraProcessSample[] = [];
    for (const line of source.split("\n")) {
        const match = line.match(
            /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
        );
        if (match === null) continue;
        const command = match[7] ?? "";
        const kind = classifyVeraProcess(command);
        if (kind === undefined) continue;
        samples.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            elapsed: match[4] ?? "unknown",
            cpuPercent: Number(match[5]),
            startedAt: match[6] ?? "unknown",
            command,
            kind,
        });
    }
    return samples;
}

interface HostStrayInput {
    readonly kind: VeraProcessKind;
    readonly command: string;
    readonly currentHost: boolean;
    readonly knownProfileHost: boolean;
    readonly isolated?: boolean;
    readonly runtimeDir?: string;
    readonly worktreeRuntime?: boolean;
}

/**
 * A process belongs here when its env names this runtime, or when it is the
 * lockfile host (or in that host's bun tree) and has no runtime env at all.
 * Missing env must not mean "this island": that would let a worktree doctor
 * SIGKILL a default-profile host that never set VERA_RUNTIME_DIR.
 */
function belongsToRuntimeIsland(
    sample: {
        readonly pid: number;
        readonly ppid: number;
        readonly runtimeDir?: string;
    },
    island: string,
    currentHostPid: number | undefined,
    tuiPid: number | undefined,
): boolean {
    if (sample.runtimeDir !== undefined) {
        return sample.runtimeDir === island;
    }
    if (currentHostPid === undefined) return false;
    if (sample.pid === currentHostPid || sample.ppid === currentHostPid) {
        return true;
    }
    if (tuiPid !== undefined && (sample.pid === tuiPid || sample.ppid === tuiPid)) {
        return true;
    }
    return false;
}

function strayHost(sample: HostStrayInput): boolean {
    if (sample.currentHost) return false;
    if (sample.worktreeRuntime === true) return false;
    if (sample.isolated === true) return true;
    if (!sample.knownProfileHost) return true;
    return false;
}

function strayProcess(
    sample: HostStrayInput & {
        readonly pid: number;
        readonly ppid: number;
    },
    strayHostPids: ReadonlySet<number>,
): boolean {
    if (sample.kind === "host") return strayHostPids.has(sample.pid);
    if (sample.kind === "test_fixture") {
        return sample.ppid === 1 || sample.isolated === true;
    }
    if (sample.kind === "worker" || sample.kind === "supervisor") {
        return sample.ppid === 1 || strayHostPids.has(sample.ppid);
    }
    if (sample.kind === "client" || sample.kind === "watchdog") {
        return sample.ppid === 1;
    }
    return false;
}

async function sampleVeraProcesses(): Promise<readonly VeraProcessSample[]> {
    const child = Bun.spawn([
        "ps",
        "-axo",
        "pid=,ppid=,pgid=,etime=,%cpu=,lstart=,command=",
    ], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, output, errorOutput] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(
            `Could not inspect Vera processes: ${errorOutput.trim() || `ps exited ${exitCode}`}`,
        );
    }
    return enrichRuntimeIdentity(parseVeraProcessList(output));
}

async function enrichRuntimeIdentity(
    samples: VeraProcessSample[],
): Promise<VeraProcessSample[]> {
    if (samples.length === 0) return samples;
    const child = Bun.spawn([
        "ps",
        "eww",
        "-p",
        samples.map((sample) => String(sample.pid)).join(","),
        "-o",
        "pid=,command=",
    ], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, output] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) return samples;
    const runtimeByPid = new Map<number, {
        readonly isolated: boolean;
        readonly runtimeDir?: string;
        readonly worktreeRuntime: boolean;
    }>();
    for (const line of output.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (match === null) continue;
        const parsed = veraRuntimeFromPsLine(match[2] ?? "");
        runtimeByPid.set(Number(match[1]), parsed);
    }
    return samples.map((sample) => {
        const runtime = runtimeByPid.get(sample.pid);
        if (runtime === undefined) return sample;
        return {
            ...sample,
            isolated: runtime.isolated,
            ...(runtime.worktreeRuntime ? { worktreeRuntime: true } : {}),
            ...(runtime.runtimeDir === undefined
                ? {}
                : { runtimeDir: runtime.runtimeDir }),
        };
    });
}

/**
 * Pull only Vera runtime overrides out of a `ps eww` command line. The rest
 * of the environment can hold credentials; this function must not return it.
 */
export function veraRuntimeFromPsLine(commandAndEnv: string): {
    readonly isolated: boolean;
    readonly runtimeDir?: string;
    readonly worktreeRuntime: boolean;
} {
    const runtimeOverride = firstEnvValue(commandAndEnv, VERA_RUNTIME_DIR_ENV);
    const home = firstEnvValue(commandAndEnv, VERA_HOME_ENV);
    const isolated = runtimeOverride !== undefined || home !== undefined;
    const worktreeRuntimeDirectory = firstEnvValue(
        commandAndEnv,
        VERA_WORKTREE_RUNTIME_ENV,
    );
    // The launcher marker is inherited by workers and their tools. It owns
    // only the runtime it names: a nested Vera that overrides
    // VERA_RUNTIME_DIR must remain eligible for cleanup inside that nested
    // island, not from a doctor invoked against a different one.
    const worktreeRuntime = runtimeOverride !== undefined
        && worktreeRuntimeDirectory === runtimeOverride;
    const runtimeDir = runtimeOverride
        ?? worktreeRuntimeDirectory
        ?? (home !== undefined
            ? join(home, "runtime")
            : undefined);
    return {
        isolated,
        worktreeRuntime,
        ...(runtimeDir === undefined ? {} : { runtimeDir }),
    };
}

function firstEnvValue(source: string, name: string): string | undefined {
    const match = source.match(new RegExp(`(?:^|\\s)${name}=(\\S+)`));
    const value = match?.[1]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
}

async function hostOwnership(island: string): Promise<VeraHostOwnership> {
    const currentHostPid = await livePidFromHostLockFile(
        join(island, "host.json"),
    );
    return {
        ...(currentHostPid === undefined ? {} : { currentHostPid }),
        knownProfileHostPids: currentHostPid === undefined
            ? new Set()
            : new Set([currentHostPid]),
    };
}

/**
 * The pid a lockfile names, if that process is still the one that wrote it.
 * This does not talk to the socket: a busy or wedged host still owns its
 * runtime, and treating silence as absence is what made launch sweep SIGKILL
 * the resident host mid-turn.
 */
export async function livePidFromHostLockFile(
    path: string,
): Promise<number | undefined> {
    const record = await readHostLockRecordFile(path);
    if (record === undefined) return undefined;
    if (!processIsAlive(record.pid)) return undefined;
    if (!recordMatchesRunningProcess(record)) return undefined;
    return record.pid;
}

function classifyVeraProcess(command: string): VeraProcessKind | undefined {
    if (/(?:^|\s)(?:\S*\/)?clients\/host\/main\.ts(?:\s|$)/.test(command)) {
        return "host";
    }
    if (/(?:^|\s)(?:\S*\/)?clients\/tui\/flight-watchdog\.ts(?:\s|$)/.test(
        command,
    )) {
        return "watchdog";
    }
    if (
        /(?:^|\s)\S*\/\.bun\/bin\/vera(?:\s|$)/.test(command)
        || /(?:^|\s)(?:\S*\/)?clients\/(?:cli|tui)\/main\.ts(?:\s|$)/.test(
            command,
        )
    ) {
        return "client";
    }
    if (/(?:^|\s)(?:\S*\/)?src\/host\/worker-supervisor\.ts(?:\s|$)/.test(
        command,
    )) {
        return "supervisor";
    }
    if (/(?:^|\s)(?:\S*\/)?src\/host\/worker\/entry\.ts(?:\s|$)/.test(command)) {
        return "worker";
    }
    if (
        /(?:^|\s)(?:\S*\/)?test\/support\/\S+-(?:child|resident-host)\.ts(?:\s|$)/
            .test(command)
    ) {
        return "test_fixture";
    }
    return undefined;
}

function processLocation(process: VeraProcessSample): string {
    if (process.kind !== "host") return process.command;
    const match = process.command.match(
        /(?:^|\s)((?:\S*\/)?clients\/host\/main\.ts)(?:\s|$)/,
    );
    const entrypoint = match?.[1];
    if (entrypoint === undefined) return process.command;
    if (entrypoint === "clients/host/main.ts") return process.command;
    return entrypoint.slice(0, -"/clients/host/main.ts".length);
}

function compareProcesses(
    left: DiagnosedVeraProcess,
    right: DiagnosedVeraProcess,
): number {
    if (left.kind !== right.kind) return left.kind === "host" ? -1 : 1;
    return right.cpuPercent - left.cpuPercent || left.pid - right.pid;
}

function sameProcessStayedAbove(
    first: VeraProcessSample | undefined,
    second: VeraProcessSample,
    highCpuPercent: number,
): boolean {
    return first !== undefined
        && first.kind === second.kind
        && first.startedAt === second.startedAt
        && first.command === second.command
        && first.cpuPercent >= highCpuPercent;
}

function ownershipMatchesProcessTable(
    ownership: VeraHostOwnership,
    processes: readonly VeraProcessSample[],
): boolean {
    const hostPids = new Set(
        processes
            .filter((process) => process.kind === "host")
            .map((process) => process.pid),
    );
    return [...ownership.knownProfileHostPids].every((pid) =>
        hostPids.has(pid)
    ) && (
        ownership.currentHostPid === undefined
        || hostPids.has(ownership.currentHostPid)
    );
}

function renderProcessRows(
    lines: string[],
    processes: readonly DiagnosedVeraProcess[],
): void {
    for (const process of processes) {
        const labels = [
            process.kind === "host" && !process.currentHost
                ? process.knownProfileHost
                    ? "other host"
                    : "unrecognized host"
                : kindLabel(process.kind),
            ...(process.sustainedHighCpu ? ["sustained high CPU"] : []),
            ...(process.stray ? ["stray, safe to stop"] : []),
        ];
        lines.push(
            `  PID ${process.pid}  ${process.cpuPercent.toFixed(1)}% CPU  age ${process.elapsed}  ${labels.join(", ")}`,
            `    ${processLocation(process)}`,
        );
    }
}

function kindLabel(kind: VeraProcessKind): string {
    if (kind === "test_fixture") return "test fixture";
    if (kind === "client") return "TUI";
    return kind;
}

const DOCTOR_HEADINGS = new Set([
    "Vera doctor",
    "Process summary",
    "Running now",
    "Issues",
    "High CPU activity",
]);

const INVENTORY_ROLE = /^(?<indent>\s+)(?<role>TUI|host|worker|supervisor|watchdog)(?<rest>\s+PID \d+.*)$/;

export type DoctorLineEmphasis =
    | "heading"
    | "success"
    | "danger"
    | "role"
    | "tally"
    | "body";

/** Color is decoration; words still name the state when this is stripped. */
export function doctorLineEmphasis(line: string): DoctorLineEmphasis {
    if (DOCTOR_HEADINGS.has(line) || line.startsWith("Stray processes:")) {
        return "heading";
    }
    if (line === "Result: healthy" || line === "No stray processes found.") {
        return "success";
    }
    if (
        line === "Result: issues found"
        || line.includes("stray")
    ) {
        return "danger";
    }
    if (INVENTORY_ROLE.test(line)) return "role";
    if (/^\s+\d+ bun  ·  /.test(line)) return "tally";
    return "body";
}

export function colorizeVeraDoctor(
    text: string,
    options: { readonly color?: boolean } = {},
): string {
    if (options.color !== true) return text;
    return text.split("\n").map(colorizeDoctorLine).join("\n");
}

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_BLUE = "\x1b[34m";
const ANSI_MAGENTA = "\x1b[35m";
const ANSI_CYAN = "\x1b[36m";

function colorizeDoctorLine(line: string): string {
    switch (doctorLineEmphasis(line)) {
        case "heading":
            return `${ANSI_BOLD}${line}${ANSI_RESET}`;
        case "success":
            return `${ANSI_GREEN}${line}${ANSI_RESET}`;
        case "danger":
            return `${ANSI_RED}${line}${ANSI_RESET}`;
        case "tally":
            return `${ANSI_BOLD}${line}${ANSI_RESET}`;
        case "role": {
            const match = INVENTORY_ROLE.exec(line);
            const role = match?.groups?.role;
            if (match === null || role === undefined) return line;
            return `${match.groups?.indent ?? ""}${roleAnsi(role)}${role}${ANSI_RESET}${match.groups?.rest ?? ""}`;
        }
        default:
            return line;
    }
}

function roleAnsi(role: string): string {
    if (role === "TUI") return ANSI_CYAN;
    if (role === "host") return ANSI_YELLOW;
    if (role === "worker") return ANSI_GREEN;
    if (role === "supervisor") return ANSI_MAGENTA;
    if (role === "watchdog") return ANSI_BLUE;
    return "";
}

function renderRunningNow(
    processes: readonly DiagnosedVeraProcess[],
): string[] {
    const owned = ownedProfileProcesses(processes);
    if (owned.length === 0) return [];
    return [
        "",
        "Running now",
        `  ${bunTally(owned)}`,
        ...inventoryRows(owned).map(inventoryRow),
    ];
}

function ownedProfileProcesses(
    processes: readonly DiagnosedVeraProcess[],
): DiagnosedVeraProcess[] {
    const host = processes.find((process) => process.currentHost);
    if (host === undefined) return [];
    const tuiPid = host.ppid > 1 ? host.ppid : undefined;
    return processes.filter((process) => {
        if (process.stray || process.kind === "test_fixture") return false;
        if (process.pid === host.pid) return true;
        if (tuiPid !== undefined && process.pid === tuiPid) return true;
        if (process.ppid === host.pid) return true;
        if (tuiPid !== undefined && process.ppid === tuiPid) return true;
        return false;
    });
}

function bunTally(owned: readonly DiagnosedVeraProcess[]): string {
    const count = (kind: VeraProcessKind) =>
        owned.filter((process) => process.kind === kind).length;
    const parts: string[] = [];
    const push = (n: number, one: string, many: string) => {
        if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
    };
    push(count("client"), "TUI", "TUI");
    push(count("host"), "host", "hosts");
    push(count("worker"), "worker", "workers");
    push(count("supervisor"), "supervisor", "supervisors");
    push(count("watchdog"), "watchdog", "watchdogs");
    return `${owned.length} bun  ·  ${parts.join("  ")}`;
}

function inventoryRows(
    owned: readonly DiagnosedVeraProcess[],
): DiagnosedVeraProcess[] {
    const ofKind = (kind: VeraProcessKind) =>
        owned.filter((process) => process.kind === kind)
            .sort((left, right) => left.pid - right.pid);
    const workers = ofKind("worker").sort((left, right) =>
        sessionLabel(left).localeCompare(sessionLabel(right))
        || left.pid - right.pid
    );
    const remaining = ofKind("supervisor");
    const takeSupervisor = (
        worker: DiagnosedVeraProcess,
        requireSession: boolean,
    ): DiagnosedVeraProcess | undefined => {
        const index = remaining.findIndex((supervisor) =>
            requireSession
                ? worker.sessionId !== undefined
                    && supervisor.sessionId === worker.sessionId
                : supervisor.ppid === worker.ppid
        );
        if (index < 0) return undefined;
        return remaining.splice(index, 1)[0];
    };
    const rows: DiagnosedVeraProcess[] = [
        ...ofKind("client"),
        ...ofKind("host"),
        ...ofKind("watchdog"),
    ];
    for (const worker of workers) {
        rows.push(worker);
        const paired = takeSupervisor(worker, true)
            ?? takeSupervisor(worker, false);
        if (paired !== undefined) rows.push(paired);
    }
    rows.push(...remaining);
    return rows;
}

function inventoryRow(process: DiagnosedVeraProcess): string {
    const role = roleLabel(process.kind).padEnd(12);
    const titled = process.kind === "worker" || process.kind === "supervisor";
    const suffix = titled ? `  ·  ${sessionLabel(process)}` : "";
    return `  ${role} PID ${process.pid}${suffix}`;
}

function roleLabel(kind: VeraProcessKind): string {
    if (kind === "client") return "TUI";
    return kind;
}

function sessionLabel(process: DiagnosedVeraProcess): string {
    const title = process.sessionTitle?.trim();
    if (title !== undefined && title.length > 0) {
        return title.length > 48 ? `${title.slice(0, 47)}…` : title;
    }
    if (process.sessionId !== undefined) return process.sessionId.slice(0, 8);
    return "untitled";
}

function withSessionLabels(
    processes: readonly DiagnosedVeraProcess[],
    sessions: readonly VeraWorkerSession[],
): DiagnosedVeraProcess[] {
    const byWorker = new Map(
        sessions.map((session) => [session.workerPid, session]),
    );
    const bySupervisor = new Map(
        sessions.flatMap((session) =>
            session.supervisorPid === undefined
                ? []
                : [[session.supervisorPid, session] as const]
        ),
    );
    return processes.map((process) => {
        const session = process.kind === "worker"
            ? byWorker.get(process.pid)
            : process.kind === "supervisor"
            ? bySupervisor.get(process.pid)
            : undefined;
        if (session === undefined) return process;
        return {
            ...process,
            sessionId: session.id,
            sessionTitle: session.title ?? session.name,
        };
    });
}

async function listCurrentHostWorkerSessions(): Promise<
    readonly VeraWorkerSession[]
> {
    try {
        const lock = await createHostLockfile().read();
        if (lock === undefined) return [];
        const sessions: VeraWorkerSession[] = [];
        let cursor: string | undefined;
        do {
            const page = await listAgentPageThroughHost(lock.socket_path, {
                limit: 200,
                order: "recent",
                ...(cursor === undefined ? {} : { cursor }),
            });
            for (const agent of page.agents) {
                if (agent.worker_pid === undefined) continue;
                sessions.push({
                    id: agent.id,
                    ...(agent.title === undefined ? {} : { title: agent.title }),
                    ...(agent.name === undefined ? {} : { name: agent.name }),
                    workerPid: agent.worker_pid,
                    ...(agent.supervisor_pid === undefined
                        ? {}
                        : { supervisorPid: agent.supervisor_pid }),
                });
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        return sessions;
    } catch {
        return [];
    }
}

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
