#!/usr/bin/env bun

import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    openSync,
    closeSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { dropDevInstance } from "../src/dev-instances.ts";
import {
    assertDistinctSockets,
    cloneVeraHome,
    hashedInstanceRoot,
    scrubLiveIdentity,
} from "../src/host/home-clone.ts";
import {
    forceStopResidentHost,
    unverifiedHostMessage,
} from "../src/host/force-stop.ts";
import {
    HostLockUnreadableError,
    inspectHostLockFile,
    inspectHostLockFileSync,
    refuseDamagedHostLock,
    type HostLockInspection,
} from "../src/host/lockfile.ts";
import { processIsAlive } from "../src/host/process-identity.ts";
import { migrateHome } from "../src/home-migration.ts";
import {
    unrecognisedEntriesIn,
    veraHomeDirectory,
    veraRuntimeDirectoryIn,
} from "../src/profile-paths.ts";
import { checkpointStoresThroughHost } from "../src/host/store-checkpoint-client.ts";
import { releaseBuildId } from "../src/release/build-id.ts";
import { requestHostIdentity } from "../src/host/protocol.ts";
import { controlSocketPath } from "../src/host/master/supervisor.ts";
import { inProcessWorkerSocket } from "../src/host/master/in-process.ts";
import { forceStopPool, ForcePoolStartupInProgressError } from "../src/host/master/force-stop-pool.ts";
import { HostStartupInProgressError } from "../src/host/startup-claim.ts";
import { defaultFactoryHomePath } from "./synthesize-factory-home.ts";

const CLI_ENTRYPOINT = fileURLToPath(
    new URL("../clients/cli/main.ts", import.meta.url),
);
const INSTANCE_META = "dev-instance.json";

export type DevTuiAction = "run" | "status" | "stop" | "discard";

export interface DevTuiRequest {
    readonly action: DevTuiAction;
    readonly fresh: boolean;
    readonly yes: boolean;
    readonly passthrough: readonly string[];
    readonly pool?: true;
    readonly noDiscovery?: true;
}

export interface DevInstanceMeta {
    readonly worktree: string;
    readonly buildId: string;
    readonly sourceHome: string;
    readonly snapshotAt: string;
}

export function parseDevTuiArgs(args: readonly string[]): DevTuiRequest {
    let action: DevTuiAction = "run";
    let fresh = false;
    let yes = false;
    let pool = false;
    let noDiscovery = false;
    const passthrough: string[] = [];
    for (const arg of args) {
        if (arg === "--status") action = "status";
        else if (arg === "--stop") action = "stop";
        else if (arg === "--discard") action = "discard";
        else if (arg === "--fresh") fresh = true;
        else if (arg === "--yes") yes = true;
        else if (arg === "--pool") pool = true;
        else if (arg === "--no-discovery") noDiscovery = true;
        else passthrough.push(arg);
    }
    return { action, fresh, yes, passthrough, ...(pool ? { pool: true } : {}), ...(noDiscovery ? { noDiscovery: true } : {}) };
}

export function factoryHomePath(worktreeRoot: string): string {
    return defaultFactoryHomePath(worktreeRoot);
}

export function candidateHomePath(
    worktreeRoot: string,
    temporaryRoot = join(tmpdir(), "vera-dev"),
): string {
    return join(
        hashedInstanceRoot(realpathSync(worktreeRoot), temporaryRoot),
        ".vera",
    );
}

// A clone of the daily home must not fire the daily schedules a second time.
export function dropClonedSchedules(home: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(join(home, "runtime", `schedules.db${suffix}`), { force: true });
    }
}

export function formatDevInstanceMarker(
    worktreeRoot: string,
    buildId: string,
): string {
    return `[DEV ${basename(worktreeRoot)} ${buildId}]`;
}

export function readInstanceMeta(home: string): DevInstanceMeta | undefined {
    const path = join(home, "runtime", INSTANCE_META);
    if (!existsSync(path)) return undefined;
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as DevInstanceMeta;
        if (
            typeof value.worktree !== "string"
            || typeof value.buildId !== "string"
            || typeof value.sourceHome !== "string"
            || typeof value.snapshotAt !== "string"
        ) {
            return undefined;
        }
        return value;
    } catch {
        return undefined;
    }
}

function writeInstanceMeta(home: string, meta: DevInstanceMeta): void {
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    writeFileSync(
        join(home, "runtime", INSTANCE_META),
        `${JSON.stringify(meta, null, 2)}\n`,
        { mode: 0o600 },
    );
}

export function resolveLinkedWorktreeRoot(cwd: string): string {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        const reason = result.stderr.toString().trim();
        throw new Error(reason || `${cwd} is not inside a Git checkout`);
    }
    const root = realpathSync(result.stdout.toString().trim());
    if (!statSync(join(root, ".git")).isFile()) {
        throw new Error(
            `${root} is the main checkout; bun run dev:tui requires a linked worktree`,
        );
    }
    return root;
}

export function candidateBuildId(worktreeRoot: string): string {
    try {
        return releaseBuildId(worktreeRoot);
    } catch {
        return "unstamped";
    }
}

export interface DevTuiDependencies extends EvictHomeOptions {
    readonly stdout?: { write(text: string): unknown };
    readonly stderr?: { write(text: string): unknown };
    readonly confirm?: (question: string) => Promise<boolean>;
    readonly spawnTui?: (
        args: readonly string[],
        env: NodeJS.ProcessEnv,
        cwd: string,
    ) => Promise<number>;
    readonly startPoolHost?: (home: string, env: NodeJS.ProcessEnv, cwd: string, noDiscovery: boolean) => Promise<void>;
    readonly checkpointDaily?: (
        socketPath: string,
        destination: string,
    ) => Promise<void>;
    readonly temporaryRoot?: string;
    readonly sourceHome?: string;
    readonly devInstanceRoot?: string;
}

export interface EvictHomeOptions {
    readonly processesUsingHome?: (home: string) => readonly HomeProcess[];
    readonly processStartTime?: (pid: number) => string | undefined;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
    readonly sigtermGraceMs?: number;
    readonly sigkillGraceMs?: number;
}

export async function runDevTui(
    args: readonly string[],
    cwd = process.cwd(),
    dependencies: DevTuiDependencies = {},
): Promise<number> {
    const request = parseDevTuiArgs(args);
    const worktreeRoot = resolveLinkedWorktreeRoot(cwd);
    const sourceHome = dependencies.sourceHome
        ?? factoryHomePath(worktreeRoot);
    const temporaryRoot = dependencies.temporaryRoot ?? join(tmpdir(), "vera-dev");
    const instanceRoot = hashedInstanceRoot(
        realpathSync(worktreeRoot),
        temporaryRoot,
    );
    const destinationHome = join(instanceRoot, ".vera");
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;

    if (request.noDiscovery && !request.pool) throw new Error("--no-discovery requires --pool");
    if (request.pool) {
        controlSocketPath(destinationHome);
        inProcessWorkerSocket(destinationHome);
    }

    if (request.action === "status") {
        stdout.write(formatStatus(worktreeRoot, sourceHome, destinationHome));
        return 0;
    }
    if (request.action === "stop") {
        return await stopCandidate(destinationHome, stderr);
    }
    if (request.action === "discard") {
        const confirm = dependencies.confirm ?? confirmDiscard;
        if (!request.yes && !await confirm(
            `Discard the development instance at ${destinationHome}?`,
        )) {
            stderr.write("Kept the development instance.\n");
            return 0;
        }
        const stopped = await stopCandidate(destinationHome, stderr);
        if (stopped !== 0) {
            stderr.write("Nothing was deleted.\n");
            return stopped;
        }
        const stranded = await evictHome(destinationHome, stderr, dependencies);
        if (stranded !== 0) return stranded;
        rmSync(instanceRoot, { recursive: true, force: true });
        dropDevInstance(destinationHome, dependencies.devInstanceRoot);
        stdout.write(`Discarded ${destinationHome}\n`);
        return 0;
    }

    // A reused home outlives edits to the worktree, so the build is read now.
    const buildId = candidateBuildId(worktreeRoot);
    if (request.pool) {
        const inspection = inspectHostLockFileSync(join(destinationHome, "runtime", "host.json"));
        if (inspection.state === "valid" && processIsAlive(inspection.record.pid)) {
            stderr.write("Stop the existing development host before starting the session worker.\n");
            return 1;
        }
        if (inspection.state === "damaged") {
            stderr.write("The development host lock is damaged. Repair it before starting the session worker.\n");
            return 1;
        }
    }
    const stale = await stopOtherBuildHost(destinationHome, buildId, stderr);
    if (stale !== 0) return stale;

    if (existsSync(destinationHome) && request.fresh) {
        const confirm = dependencies.confirm ?? confirmDiscard;
        if (!request.yes && !await confirm(
            `Replace the development instance at ${destinationHome}?`,
        )) {
            stderr.write("Kept the existing development instance.\n");
            return 0;
        }
        const stopped = await stopCandidate(destinationHome, stderr);
        if (stopped !== 0) {
            stderr.write("Nothing was deleted.\n");
            return stopped;
        }
        const stranded = await evictHome(destinationHome, stderr, dependencies);
        if (stranded !== 0) return stranded;
        rmSync(destinationHome, { recursive: true, force: true });
    }

    const existed = existsSync(destinationHome);
    if (!existed) {
        if (!existsSync(sourceHome)) {
            throw new Error(
                `Factory home is missing at ${sourceHome}. `
                + "Synthesize it with bun run factory:home.",
            );
        }
        try {
            // A host that may be running cannot be checkpointed before the copy.
            refuseDamagedHostLock(
                inspectHostLockFileSync(join(sourceHome, "runtime", "host.json")),
            );
        } catch (error) {
            if (!(error instanceof HostLockUnreadableError)) throw error;
            stderr.write(`${error.message}\n`);
            return 1;
        }
        mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
        try {
            await cloneVeraHome({
                sourceHome,
                destinationHome,
            });
        } catch (error) {
            throw new Error(
                `Could not clone ${sourceHome} into ${destinationHome}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
    const lifted = liftCloneHome(destinationHome);
    if (lifted) scrubLiveIdentity(destinationHome);
    else scrubForeignHostIdentity(destinationHome);
    quarantineUnknownHomeEntries(destinationHome);
    if (!existed) {
        const dailySocket = join(sourceHome, "runtime", "host.sock");
        if (dailyHostAppearsRunning(sourceHome) && existsSync(dailySocket)) {
            try {
                await (dependencies.checkpointDaily ?? checkpointStoresThroughHost)(
                    dailySocket,
                    join(destinationHome, "runtime"),
                );
            } catch (error) {
                rmSync(destinationHome, { recursive: true, force: true });
                throw new Error(
                    `Checkpoint failed; clone refused: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        writeInstanceMeta(destinationHome, {
            worktree: worktreeRoot,
            buildId,
            sourceHome,
            snapshotAt: new Date().toISOString(),
        });
    }
    if (!existed || lifted) {
        dropClonedSchedules(destinationHome);
    }
    if (lifted && existed) {
        writeInstanceMeta(destinationHome, {
            worktree: worktreeRoot,
            buildId,
            sourceHome,
            snapshotAt: new Date().toISOString(),
        });
    }
    assertDistinctSockets(destinationHome, sourceHome);

    const meta = readInstanceMeta(destinationHome);
    if (meta !== undefined && meta.buildId !== buildId) {
        writeInstanceMeta(destinationHome, { ...meta, buildId });
    }
    const spawn = dependencies.spawnTui ?? spawnWorktreeTui;
    const env = candidateLaunchEnv(destinationHome, worktreeRoot, buildId);
    if (request.pool) {
        env.VERA_DEV_INSTANCE = `${basename(worktreeRoot)} dev`;
        await (dependencies.startPoolHost ?? startPoolHost)(destinationHome, env, worktreeRoot, request.noDiscovery === true);
    }
    return await spawn(
        request.passthrough,
        env,
        worktreeRoot,
    );
}

async function startPoolHost(home: string, env: NodeJS.ProcessEnv, cwd: string, noDiscovery: boolean): Promise<void> {
    const entry = fileURLToPath(new URL("../clients/host/main.ts", import.meta.url));
    const runtime = veraRuntimeDirectoryIn(home);
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const logPath = join(runtime, "pool-start.log");
    const log = openSync(logPath, "w", 0o600);
    const child = spawn(process.execPath, [entry, "--pool", ...(noDiscovery ? ["--no-discovery"] : [])], {
        cwd, env, detached: true, stdio: ["ignore", log, log],
    });
    closeSync(log);
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    const error = new Promise<never>((_resolve, reject) => child.once("error", reject));
    try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error("The development host exited during startup.");
            const identity = await Promise.race([
                requestHostIdentity(join(runtime, "host.sock")).catch(() => undefined),
                error,
            ]);
            const lock = inspectHostLockFileSync(join(runtime, "host.json"));
            if (identity?.pid === child.pid && lock.state === "valid" && lock.record.pid === child.pid) {
                const worker = lock.record.worker_count === undefined ? undefined
                    : await requestHostIdentity(inProcessWorkerSocket(home)).catch(() => undefined);
                if (lock.record.worker_count === undefined || worker?.role === "worker") {
                    child.unref();
                    return;
                }
            }
            await Bun.sleep(25);
        }
        throw new Error("The development session worker did not become ready.");
    } catch (failure) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const stopped = await Promise.race([exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
        if (!stopped) {
            child.kill("SIGKILL");
            await exited;
        }
        throw failure;
    }
}

/** Lift a cloned profiles/ tree in place. Never touches the daily home. */
export function liftCloneHome(home: string): boolean {
    if (!existsSync(join(home, "profiles"))) return false;
    migrateHome(home);
    return true;
}

function scrubForeignHostIdentity(home: string): void {
    const runtime = join(home, "runtime");
    let record: { socket_path?: unknown } | null;
    try {
        record = JSON.parse(readFileSync(join(runtime, "host.json"), "utf8"));
    } catch {
        return;
    }
    if (
        typeof record?.socket_path === "string"
        && record.socket_path !== join(runtime, "host.sock")
    ) {
        scrubLiveIdentity(home);
    }
}

function uniqueLeftoverPath(leftover: string, entry: string): string {
    const first = join(leftover, entry);
    if (!existsSync(first)) return first;
    for (let n = 2; ; n += 1) {
        const candidate = join(leftover, `${entry}-${n}`);
        if (!existsSync(candidate)) return candidate;
    }
}

/** Move leftover root files into machine/leftover so the clone can start. */
export function quarantineUnknownHomeEntries(home: string): void {
    const leftover = join(home, "machine", "leftover");
    for (const entry of unrecognisedEntriesIn(home)) {
        mkdirSync(leftover, { recursive: true, mode: 0o700 });
        renameSync(join(home, entry), uniqueLeftoverPath(leftover, entry));
    }
}

export function candidateLaunchEnv(
    destinationHome: string,
    worktreeRoot: string,
    buildId: string,
    base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env = { ...base };
    delete env.VERA_RUNTIME_DIR;
    delete env.VERA_WORKTREE_RUNTIME;
    env.VERA_HOME = destinationHome;
    env.VERA_DEV_INSTANCE = `${basename(worktreeRoot)} ${buildId}`;
    return env;
}

function formatStatus(
    worktreeRoot: string,
    sourceHome: string,
    destinationHome: string,
): string {
    const meta = existsSync(destinationHome)
        ? readInstanceMeta(destinationHome)
        : undefined;
    const inspection = inspectHostLockFileSync(
        join(destinationHome, "runtime", "host.json"),
    );
    return [
        `Worktree: ${worktreeRoot}`,
        `Build: ${candidateBuildId(worktreeRoot)}`,
        `Home: ${destinationHome}`,
        `Socket: ${join(destinationHome, "runtime", "host.sock")}`,
        `Host PID: ${describeHostPid(inspection)}`,
        `Snapshot: ${meta?.snapshotAt ?? "none"}`,
        `Source: ${sourceHome}`,
        "",
    ].join("\n");
}

function describeHostPid(inspection: HostLockInspection): string {
    if (inspection.state === "absent") return "not running";
    if (inspection.state === "valid") {
        return processIsAlive(inspection.record.pid)
            ? String(inspection.record.pid)
            : "not running";
    }
    const note = `the host lockfile ${inspection.path} is damaged`;
    if (inspection.pid === undefined) return `unknown (${note})`;
    const pid = processIsAlive(inspection.pid)
        ? String(inspection.pid)
        : "not running";
    return `${pid} (${note})`;
}

function dailyHostAppearsRunning(sourceHome: string): boolean {
    const inspection = inspectHostLockFileSync(
        join(sourceHome, "runtime", "host.json"),
    );
    return inspection.state === "valid" && processIsAlive(inspection.record.pid);
}

/** A client refuses a host from another build, so a leftover one is stopped rather than left to block the launch. */
async function stopOtherBuildHost(
    destinationHome: string,
    buildId: string,
    stderr: { write(text: string): unknown },
): Promise<number> {
    const lockPath = join(destinationHome, "runtime", "host.json");
    const inspection = await inspectHostLockFile(lockPath);
    if (inspection.state === "absent") return 0;
    // A damaged lock names no build: the stop path clears a stale one and
    // refuses to launch over a host that may still be running.
    if (inspection.state === "damaged") {
        return await stopCandidate(destinationHome, stderr);
    }
    const record = inspection.record;
    if (
        buildId === "unstamped"
        || record.build_id === undefined
        || record.build_id === buildId
        || !processIsAlive(record.pid)
    ) {
        return 0;
    }
    stderr.write(
        `Stopping development host PID ${record.pid} from build ${record.build_id}; this is ${buildId}.\n`,
    );
    return await stopCandidate(destinationHome, stderr);
}

async function stopCandidate(
    destinationHome: string,
    stderr: { write(text: string): unknown },
): Promise<number> {
    const lockPath = join(destinationHome, "runtime", "host.json");
    const reported = new Set<number>();
    const reportWorker = (pid: number): void => {
        if (reported.has(pid)) return;
        reported.add(pid);
        stderr.write(`Stopped session process PID ${pid}.\n`);
    };
    try {
        const pool = await forceStopPool(destinationHome, { onWorkerStopped: reportWorker });
        if (pool !== undefined) {
            for (const pid of pool.workerPids) reportWorker(pid);
            return 0;
        }
    } catch (error) {
        if (error instanceof ForcePoolStartupInProgressError) {
            for (const pid of error.stoppedWorkerPids) reportWorker(pid);
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    let outcome: Awaited<ReturnType<typeof forceStopResidentHost>>;
    try {
        outcome = await forceStopResidentHost({ lockPath, home: destinationHome });
    } catch (error) {
        if (!(error instanceof HostLockUnreadableError) && !(error instanceof HostStartupInProgressError)) throw error;
        stderr.write(`${error.message}\n`);
        return 1;
    }
    if (outcome === undefined) {
        stderr.write("No development instance host is running.\n");
        return 0;
    }
    // No default arm: a new endedBy value must fail to compile here.
    switch (outcome.endedBy) {
        case "sigterm":
        case "sigkill":
        case "already_dead":
        case "not_ours":
            return 0;
        case "survived":
            stderr.write(`Development host PID ${outcome.pid} did not stop.\n`);
            return 1;
        case "unverified":
            stderr.write(`${unverifiedHostMessage(outcome, lockPath)}\n`);
            return 1;
    }
}

const EVICTION_SIGTERM_GRACE_MS = 3_000;

const EVICTION_SIGKILL_GRACE_MS = 2_000;

const EVICTION_POLL_MS = 50;

export interface HomeProcess {
    readonly pid: number;
    readonly startedAt?: string;
}

function normalizeStartTime(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

/** Every live process holding this home, found by the home it was given rather than by a lockfile one of them has since overwritten. */
export function processesUsingHome(home: string): readonly HomeProcess[] {
    const listed = spawnSync("ps", ["axeww", "-o", "pid=,lstart=,command="], {
        encoding: "utf8",
        // Every process is listed with its whole environment, which on a
        // developer's machine runs to megabytes.
        maxBuffer: 64 * 1024 * 1024,
    });
    if (listed.status !== 0 || typeof listed.stdout !== "string") {
        throw new Error("Could not list development processes");
    }
    const holds = new RegExp(
        `VERA_HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`,
    );
    return listed.stdout.split("\n").flatMap((line) => {
        if (!holds.test(line)) return [];
        const pid = Number.parseInt(line.trimStart().split(/\s/)[0] ?? "", 10);
        if (!Number.isInteger(pid) || pid === process.pid) return [];
        const match = /^\s*\d+\s+(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s/.exec(line);
        return [{ pid, ...(match === null ? {} : { startedAt: normalizeStartTime(match[1]!) }) }];
    });
}

function processStartTime(pid: number): string | undefined {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    const value = normalizeStartTime(result.stdout);
    return value.length === 0 ? undefined : value;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch {
        // Already gone, or not ours to signal. Either way it is counted below.
    }
}

async function noneLeft(
    home: string,
    graceMs: number,
    list: (home: string) => readonly HomeProcess[],
): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (list(home).length > 0) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, EVICTION_POLL_MS));
    }
    return true;
}

/**
 * Empties a development home of everything still running against it. A host
 * that outlived its lockfile still holds the socket the next one needs, so a
 * fresh start that leaves one behind is not a fresh start.
 */
export async function evictHome(
    home: string,
    stderr: { write(text: string): unknown },
    options: EvictHomeOptions = {},
): Promise<number> {
    const listProcesses = options.processesUsingHome ?? processesUsingHome;
    const signal = options.signalProcess ?? signalProcess;
    const readStartTime = options.processStartTime ?? processStartTime;
    const isAlive = options.isProcessAlive ?? processIsAlive;
    const list = (path: string): readonly HomeProcess[] => {
        try {
            return listProcesses(path);
        } catch {
            throw new HomeProcessListError();
        }
    };
    const known = new Map<number, HomeProcess>();
    const signalVerified = (record: HomeProcess, name: NodeJS.Signals): void => {
        const previous = known.get(record.pid);
        const actual = readStartTime(record.pid);
        if (actual === undefined && !isAlive(record.pid)) return;
        if (record.startedAt === undefined || actual !== record.startedAt
            || (previous !== undefined && previous.startedAt !== record.startedAt)) {
            throw new HomeProcessIdentityError(record.pid);
        }
        known.set(record.pid, record);
        signal(record.pid, name);
    };
    try {
        const holding = list(home);
        if (holding.length === 0) return 0;
        for (const record of holding) signalVerified(record, "SIGTERM");
        const polite = options.sigtermGraceMs ?? EVICTION_SIGTERM_GRACE_MS;
        if (!await noneLeft(home, polite, list)) {
            for (const record of list(home)) signalVerified(record, "SIGKILL");
            await noneLeft(home, options.sigkillGraceMs ?? EVICTION_SIGKILL_GRACE_MS, list);
        }
        const survivors = list(home);
        if (survivors.length > 0) {
            stderr.write(
                `Could not stop ${survivors.length} process(es) still using `
                    + `${home}: ${survivors.map((record) => record.pid).join(", ")}.\n`,
            );
            return 1;
        }
        stderr.write(
            `Stopped ${holding.length} process(es) from the previous `
                + "development instance.\n",
        );
        return 0;
    } catch (error) {
        if (error instanceof HomeProcessIdentityError) {
            stderr.write(`Could not verify PID ${error.pid} is a process using ${home}; the development instance was kept.\n`);
            return 1;
        }
        if (error instanceof HomeProcessListError) {
            stderr.write(`Could not list processes using ${home}; the development instance was kept.\n`);
            return 1;
        }
        throw error;
    }
}

class HomeProcessIdentityError extends Error {
    constructor(readonly pid: number) { super(); }
}

class HomeProcessListError extends Error {}

async function confirmDiscard(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await rl.question(`${question} [y/N] `);
        return answer.trim().toLowerCase() === "y";
    } finally {
        rl.close();
    }
}

async function spawnWorktreeTui(
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
): Promise<number> {
    const child = Bun.spawn(
        [process.execPath, CLI_ENTRYPOINT, ...args],
        {
            cwd,
            env,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        },
    );
    return await child.exited;
}

if (import.meta.main) {
    try {
        process.exitCode = await runDevTui(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(
            `Could not launch Vera's development TUI: ${
                error instanceof Error ? error.message : String(error)
            }\n`,
        );
        process.exitCode = 1;
    }
}
