import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
    createHostLockfile,
    HostProtocolMismatchError,
} from "../src/host/lockfile.ts";
import { veraHomeDirectory } from "../src/profile-paths.ts";

const DEFAULT_SAMPLE_INTERVAL_MS = 750;
const DEFAULT_HIGH_CPU_PERCENT = 50;
const MAX_QUIET_UNRECOGNIZED_HOSTS = 5;

export type VeraProcessKind = "host" | "client";

export interface VeraProcessSample {
    readonly pid: number;
    readonly ppid: number;
    readonly elapsed: string;
    readonly cpuPercent: number;
    readonly startedAt: string;
    readonly command: string;
    readonly kind: VeraProcessKind;
}

export interface DiagnosedVeraProcess extends VeraProcessSample {
    readonly currentHost: boolean;
    readonly knownProfileHost: boolean;
    readonly sustainedHighCpu: boolean;
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
}

export interface VeraHostOwnership {
    readonly currentHostPid?: number;
    readonly knownProfileHostPids: ReadonlySet<number>;
}

export async function diagnoseVeraProcesses(
    options: VeraDoctorOptions = {},
): Promise<VeraDoctorReport> {
    const readHostOwnership = options.readHostOwnership ?? hostOwnership;
    const sampleProcesses = options.sampleProcesses ?? sampleVeraProcesses;
    const wait = options.wait ?? waitFor;
    const interval = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    const highCpuPercent = options.highCpuPercent ?? DEFAULT_HIGH_CPU_PERCENT;
    const doctorPid = options.doctorPid ?? process.pid;

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
    const processes = secondSample
        .filter((sample) => sample.pid !== doctorPid)
        .map((sample): DiagnosedVeraProcess => ({
            ...sample,
            currentHost: sample.kind === "host"
                && sample.pid === currentHostPid,
            knownProfileHost: sample.kind === "host"
                && sample.pid !== currentHostPid
                && knownProfileHostPids.has(sample.pid),
            sustainedHighCpu:
                sample.cpuPercent >= highCpuPercent
                && sameProcessStayedAbove(
                    firstByPid.get(sample.pid),
                    sample,
                    highCpuPercent,
                ),
        }))
        .sort(compareProcesses);
    const currentHostMissing = currentHostPid !== undefined
        && !processes.some((sample) =>
            sample.kind === "host" && sample.pid === currentHostPid
        );
    const unrecognizedHosts = processes.filter((sample) =>
        sample.kind === "host"
        && !sample.currentHost
        && !sample.knownProfileHost
    );
    return {
        healthy: !currentHostMissing
            && unrecognizedHosts.length === 0,
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
    const extraHosts = hosts.filter((process) => !process.currentHost);
    const knownProfileHosts = extraHosts.filter((process) =>
        process.knownProfileHost
    );
    const unrecognizedHosts = extraHosts.filter((process) =>
        !process.knownProfileHost
    );
    const highCpu = report.processes.filter((process) =>
        process.sustainedHighCpu
    );
    const lines = [
        "Vera doctor",
        "",
        "Process summary",
        `  Resident hosts: ${hosts.length} (${unrecognizedHosts.length} unrecognized, ${knownProfileHosts.length} other profile${knownProfileHosts.length === 1 ? "" : "s"})`,
        `  Vera clients: ${clients.length}`,
        `  Current profile host: ${report.currentHostPid === undefined
            ? "not running"
            : `PID ${report.currentHostPid}`}`,
    ];
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
                `  Current profile host PID ${report.currentHostPid} was not found in the process table.`,
            );
        }
        renderProcessRows(lines, shownIssues);
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
    lines.push("No processes were stopped.");
    return `${lines.join("\n")}\n`;
}

export function parseVeraProcessList(source: string): VeraProcessSample[] {
    const samples: VeraProcessSample[] = [];
    for (const line of source.split("\n")) {
        const match = line.match(
            /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
        );
        if (match === null) continue;
        const command = match[6] ?? "";
        const kind = classifyVeraProcess(command);
        if (kind === undefined) continue;
        samples.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            elapsed: match[3] ?? "unknown",
            cpuPercent: Number(match[4]),
            startedAt: match[5] ?? "unknown",
            command,
            kind,
        });
    }
    return samples;
}

async function sampleVeraProcesses(): Promise<readonly VeraProcessSample[]> {
    const child = Bun.spawn([
        "ps",
        "-axo",
        "pid=,ppid=,etime=,%cpu=,lstart=,command=",
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
    return parseVeraProcessList(output);
}

async function hostOwnership(): Promise<VeraHostOwnership> {
    const [currentHostPid, knownProfileHostPids] = await Promise.all([
        currentProfileHostPid(),
        knownProfileHosts(),
    ]);
    if (currentHostPid !== undefined) knownProfileHostPids.add(currentHostPid);
    return { currentHostPid, knownProfileHostPids };
}

async function currentProfileHostPid(): Promise<number | undefined> {
    try {
        return (await createHostLockfile().read())?.pid;
    } catch (error) {
        if (error instanceof HostProtocolMismatchError) return error.pid;
        throw error;
    }
}

async function knownProfileHosts(): Promise<Set<number>> {
    const profilesPath = join(veraHomeDirectory(), "profiles");
    let entries;
    try {
        entries = await readdir(profilesPath, { withFileTypes: true });
    } catch (error) {
        if (isMissingFileError(error)) return new Set();
        throw error;
    }
    const pids = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => activeProfileHostPid(
                join(profilesPath, entry.name, "runtime", "host.json"),
            )),
    );
    return new Set(pids.filter((pid): pid is number => pid !== undefined));
}

async function activeProfileHostPid(
    lockPath: string,
): Promise<number | undefined> {
    let serialized;
    try {
        serialized = await readFile(lockPath, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) return undefined;
        throw error;
    }
    const record = parseHostLockStub(serialized);
    if (record === undefined) return undefined;
    try {
        return (await createHostLockfile({
            path: lockPath,
            socketPath: record.socketPath,
        }).read())?.pid;
    } catch (error) {
        if (error instanceof HostProtocolMismatchError) return error.pid;
        throw error;
    }
}

function parseHostLockStub(
    source: string,
): { readonly pid: number; readonly socketPath: string } | undefined {
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
        !Number.isInteger(record.pid)
        || (record.pid as number) <= 0
        || typeof record.socket_path !== "string"
        || record.socket_path.length === 0
    ) {
        return undefined;
    }
    return {
        pid: record.pid as number,
        socketPath: record.socket_path,
    };
}

function classifyVeraProcess(command: string): VeraProcessKind | undefined {
    if (/(?:^|\s)(?:\S*\/)?clients\/host\/main\.ts(?:\s|$)/.test(command)) {
        return "host";
    }
    if (
        /(?:^|\s)\S*\/\.bun\/bin\/vera(?:\s|$)/.test(command)
        || /(?:^|\s)(?:\S*\/)?clients\/(?:cli|tui)\/main\.ts(?:\s|$)/.test(
            command,
        )
    ) {
        return "client";
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
                    ? "other profile host"
                    : "unrecognized host"
                : process.kind,
            ...(process.sustainedHighCpu ? ["sustained high CPU"] : []),
        ];
        lines.push(
            `  PID ${process.pid}  ${process.cpuPercent.toFixed(1)}% CPU  age ${process.elapsed}  ${labels.join(", ")}`,
            `    ${processLocation(process)}`,
        );
    }
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
