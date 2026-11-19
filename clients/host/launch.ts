import { BOOT_FAILURE_LIMIT, clearBootFailures, countsAsBootFailure, HostBootLoopError, recentBootFailures, recordBootFailure } from "./boot-failures.ts";

export { clearBootFailures, countsAsBootFailure, HostBootLoopError, recentBootFailures, HOST_STARTUP_RACE_EXIT_CODE } from "./boot-failures.ts";

import { spawn } from "node:child_process";
import {
    existsSync,
    readFileSync,
    statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadOptionalVeraConfig, VeraConfigError } from "../../src/config.ts";
import {
    ensureResidentHost,
    HostStartDeadlineError,
    type EnsureResidentHostOptions,
} from "../../src/host/discovery.ts";
import {
    createHostLockfile,
    defaultHostSocketPath,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    hostHomeProblem,
    hostSocketPathProblem,
    readHostStartupFailure,
} from "../../src/host/startup-failure.ts";
import {
    VERA_HOME_ENV,
    selectedVeraHome,
} from "../../src/profile-paths.ts";
import { dispatchToHostRelease } from "../../src/release/dispatch.ts";
import {
    childReleaseRoot,
    currentReleaseBuildId,
    packedReleaseRoot,
    RELEASE_HOST_NAME,
    releaseBinaryPath,
    releaseDirectory,
    rollbackReleaseBuildId,
    runningInstallPrefix,
} from "../../src/release/layout.ts";
import { activateRelease } from "../../src/release/activate.ts";
import { releaseProblem } from "../../src/release/handoff.ts";
import { bootResidentHost, renderBootBox, type BootCheck, type BootInspection, type BootQuestion, type HostMode } from "../../src/host/boot.ts";
import { clientOwnedWatchdog, discoverResetProcesses, stoppableResetCandidates } from "../../src/host/reset-discovery.ts";
import { runHostReset } from "../../src/host/reset.ts";
import { realResetSystem } from "../../src/host/reset-system.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity, type HostIdentity } from "../../src/host/protocol.ts";
import { openFilesUnder, restoreRuntimeStash, stashRuntime } from "../../src/host/runtime-stash.ts";
import { forceStopResidentHost, gracefulStopResidentHost } from "../../src/host/force-stop.ts";
import { homeFilesystemProblem } from "../../src/host/home-filesystem.ts";
import { targetPidIsAncestor } from "../../src/host/process-ancestry.ts";
import type { WorkerRecord, WorkerRecordScan } from "../../src/host/pool/worker-record.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { acquireHostStartupClaim, HostStartupInProgressError } from "../../src/host/startup-claim.ts";
import { hostEnvironmentProblem, hostLaunchEnvironment } from "../../src/host/host-environment.ts";
import { cliHostRequester } from "../../src/host/requester.ts";
import type { HostRequester } from "../../src/host/protocol.ts";

export { sessionWorkerSpawnSpec } from "../../src/host/pool/worker-launch.ts";

export type FindOrStartHostOptions = Omit<
    EnsureResidentHostOptions,
    "startHost"
> & {
    // How the startup check reports; the default draws the box on stderr when something was not ok.
    readonly boot?: {
        readonly full?: boolean;
        readonly onCheck?: (check: BootCheck) => void;
        readonly render?: (checks: readonly BootCheck[]) => void;
        // Told once when another boot for this home holds the lock.
        readonly onWaiting?: (holderPid: number | undefined) => void;
        // Answers boot questions; the default asks on the terminal.
        readonly confirm?: (question: BootQuestion) => Promise<boolean>;
    };
};

const pooledHomes = new Set<string>();

export async function findOrStartResidentHost(
    findOptions: FindOrStartHostOptions = {},
): Promise<HostLockRecord> {
    const { boot, ...options } = findOptions;
    const requester = options.requester ?? cliHostRequester("startup");
    const home = selectedVeraHome();
    // No host can exist at either fault, and every step below would fail on it with a bare errno.
    const unusable = hostHomeProblem(home) ?? hostSocketPathProblem(home);
    if (unusable !== undefined) throw unusable;
    const baseLockfile = options.lockfile ?? createHostLockfile();
    let pool = pooledHomes.has(home);
    const remember = (record: HostLockRecord | undefined): void => {
        if (record === undefined) return;
        pool = record.worker_count !== undefined;
        if (pool) pooledHomes.add(home);
        else pooledHomes.delete(home);
    };
    const lockfile = {
        publish: () => baseLockfile.publish(),
        read: async () => {
            const record = await baseLockfile.read();
            remember(record);
            return record;
        },
        ...(baseLockfile.diagnose === undefined ? {} : {
            diagnose: async () => {
                const diagnosis = await baseLockfile.diagnose!();
                remember(diagnosis.record);
                return diagnosis;
            },
        }),
    };
    const dispatched = await dispatchToHostRelease({
        inspectHost: async () => (await lockfile.read())?.build_id,
    });
    if (dispatched !== undefined) {
        process.exit(dispatched);
    }
    let releaseRoot: string | undefined;
    const host = await bootResidentHost({
        hostPublished: async () => (await lockfile.read()) !== undefined,
        hostAnswer: () => requestHostIdentity(defaultHostSocketPath(home)),
        inspect: () => inspectHome(),
        adopt: async () => {
            const workers = await adoptableWorkers();
            if (workers === undefined) return undefined;
            const { inspectWorkerRecords } = await import("../../src/host/pool/worker-record.ts");
            pool = true;
            const host = await startNamingCause(() => ensureResidentHost({
                ...options,
                requester,
                lockfile,
                startHost: () => spawnDetachedResidentHost(true, "default", releaseRoot),
            }));
            const deadline = performance.now() + 30_000;
            while (performance.now() < deadline && processIsAlive(host.pid)) {
                const current = await inspectWorkerRecords(home, thisProcessBuildId(), { removeStale: false }).catch(() => undefined);
                const identity = await requestHostIdentity(host.socket_path);
                if (adoptionComplete(host, identity, current, workers)) return host;
                await Bun.sleep(100);
            }
            throw new Error("Session processes could not be adopted");
        },
        recover: () => recoverHome(requester),
        start: (mode) => startNamingCause(() => ensureResidentHost({
            ...options,
            requester,
            lockfile,
            startHost: () => spawnDetachedResidentHost(pool, mode, releaseRoot),
        })),
        rollback: async () => {
            const target = rollbackTarget();
            if (target === undefined) return undefined;
            activateRelease(target.root, target.prefix);
            releaseRoot = target.root;
            return target.buildId;
        },
        clearBootFailures,
        confirm: boot?.confirm ?? confirmBootQuestion,
        stash: async (unknown) => stashRuntime(selectedVeraHome(), {
            reason: "Vera could not start with this runtime folder.",
            unknown_processes: unknown,
        }),
        restoreStash: async (path) => { restoreRuntimeStash(selectedVeraHome(), path); },
        stopHost: (record) => stopStartedHost(record),
        render: boot?.render ?? ((checks) => { process.stderr.write(renderBootBox(checks)); }),
        ...(boot?.onCheck === undefined ? {} : { onCheck: boot.onCheck }),
        ...(boot?.full === true ? { full: true } : {}),
        exclusive: (run) => withBootLock(run, boot?.onWaiting),
    });
    remember(host);
    return host;
}

function adoptionComplete(
    host: HostLockRecord,
    identity: HostIdentity | undefined,
    current: WorkerRecordScan | undefined,
    workers: readonly WorkerRecord[],
): boolean {
    if (identity?.pid !== host.pid) return false;
    if (host.worker_count === undefined || identity.workers_ready !== host.worker_count) return false;
    if (current === undefined) return false;
    return workers.every((worker) => current.recoverable.some(({ record }) =>
        record.id === worker.id && record.pid === worker.pid && record.started_at === worker.started_at
        && record.host_pid === host.pid));
}

async function adoptableWorkers(): Promise<readonly WorkerRecord[] | undefined> {
    if (loadOptionalVeraConfig()?.host?.workers === 0) return undefined;
    const discovery = await discoverResetProcesses(realResetSystem());
    if (discovery.hostAnswer !== undefined) return undefined;
    if (discovery.unproven.length > 0) return undefined;
    const clients = [
        process.pid,
        ...discovery.candidates.filter((candidate) => candidate.role === "client").map((candidate) => candidate.pid),
    ];
    for (const candidate of discovery.candidates) {
        if (candidate.role === "client") continue;
        if (candidate.role === "worker") continue;
        if (clientOwnedWatchdog(candidate, clients)) continue;
        return undefined;
    }
    const { inspectWorkerRecords } = await import("../../src/host/pool/worker-record.ts");
    const scan = await inspectWorkerRecords(discovery.home, thisProcessBuildId(), { removeStale: false });
    if (scan.recoverable.length === 0) return undefined;
    if (scan.pending.length > 0) return undefined;
    if (scan.stale.length > 0) return undefined;
    const workers = scan.recoverable.map(({ record }) => record);
    if (workers.some((record) => processIsAlive(record.host_pid))) return undefined;
    const previousHost = discovery.lock.state === "valid" ? discovery.lock.record.pid : undefined;
    if (previousHost !== undefined && workers.some((record) => record.host_pid !== previousHost)) return undefined;
    const candidates = discovery.candidates.filter((candidate) => candidate.role === "worker");
    if (candidates.length !== workers.length) return undefined;
    if (candidates.some((candidate) => !workers.some((record) => record.pid === candidate.pid))) return undefined;
    const { occupiedWorkerSockets } = await import("../../src/host/pool/worker-sockets.ts");
    const sockets = await occupiedWorkerSockets(discovery.home, 0);
    if (sockets.some((socket) => !workers.some((record) => record.socket_path === socket.path))) return undefined;
    return workers;
}

async function inspectHome(): Promise<BootInspection> {
    const discovery = await discoverResetProcesses(realResetSystem());
    const hostAnswers = discovery.hostAnswer !== undefined;
    const lock: BootInspection["lock"] = discovery.lock.state === "absent" ? "absent"
        : discovery.lock.state === "valid" ? (processIsAlive(discovery.lock.record.pid) ? "live" : "stale")
        : "damaged";
    const orphans = hostAnswers ? 0 : stoppableResetCandidates(discovery.candidates).length;
    const problem = activeReleaseProblem();
    const homeProblem = homeFilesystemProblem(discovery.home);
    const blocker = configBlocker() ?? environmentBlocker(discovery.home);
    return {
        ...(blocker === undefined ? {} : { startBlocker: blocker }),
        home: discovery.home,
        ...(homeProblem === undefined ? {} : { homeProblem }),
        hostAnswers,
        lock,
        orphans,
        unproven: discovery.unproven.length,
        unknownProcesses: discovery.unproven.map((item) => {
            const open = openFilesUnder(item.pid, discovery.home);
            return `PID ${item.pid}: ${item.reason}${open.length === 0 ? "" : `; holds open ${open.slice(0, 5).join(", ")}${open.length > 5 ? ` and ${open.length - 5} more` : ""}`}`;
        }),
        ...(problem === undefined ? {} : { releaseProblem: problem }),
        bootLoop: recentBootFailures(Date.now()).length >= BOOT_FAILURE_LIMIT,
    };
}

// A config the host would refuse, found before a start is tried and a repair that cannot help is offered.
function configBlocker(): BootInspection["startBlocker"] {
    try {
        loadOptionalVeraConfig();
    } catch (error) {
        if (error instanceof VeraConfigError) return { label: "Config", error };
        return {
            label: "Config",
            error: new Error(
                `Vera cannot read its config: ${error instanceof Error ? error.message : String(error)}.\n`
                + "Fix that file's permissions or move it aside, then run Vera again.",
            ),
        };
    }
    return undefined;
}

function environmentBlocker(home: string): BootInspection["startBlocker"] {
    const error = hostEnvironmentProblem(home);
    return error === undefined ? undefined : { label: "Host env file", error };
}

// The host's output is discarded, so a start that timed out names the cause the host left behind.
export async function startNamingCause(start: () => Promise<HostLockRecord>): Promise<HostLockRecord> {
    const startedAt = Date.now();
    try {
        return await start();
    } catch (error) {
        const failure = error instanceof HostStartDeadlineError
            ? readHostStartupFailure(startedAt)
            : undefined;
        if (failure === undefined) throw error;
        throw new HostStartFailedError(failure.message);
    }
}

export class HostStartFailedError extends Error {
    constructor(reason: string) {
        super(`The Vera host stopped while starting: ${reason}`);
        this.name = "HostStartFailedError";
    }
}

// Same steps as 'vera host reset --yes': back up, stop this home's processes by pid and start time, clear runtime files.
export async function recoverHome(requester: HostRequester): Promise<{ ok: boolean; changed: boolean; lines: string[] }> {
    // Stopping a host this command runs under would end the command and its session.
    const discovery = await discoverResetProcesses(realResetSystem());
    const own = discovery.candidates.find((candidate) => candidate.role !== "client" && targetPidIsAncestor(candidate.pid) === true);
    if (own !== undefined) {
        return {
            ok: false,
            changed: false,
            lines: [`This command runs inside Vera ${own.role} PID ${own.pid}, so nothing was stopped. Run vera from a terminal outside Vera.`],
        };
    }
    const lines: string[] = [];
    const code = await runHostReset({ assumeYes: true, requester }, {
        system: realResetSystem(),
        confirm: async () => true,
        output: (text) => { lines.push(...text.split("\n").filter((line) => line.trim().length > 0)); },
        errorOutput: (text) => { lines.push(...text.split("\n").filter((line) => line.trim().length > 0)); },
    });
    const summary = lines.filter((line) => /^(Backup|Stopped|Removed|Nothing to reset|PID|Could not)/.test(line));
    const changed = !summary.some((line) => line.startsWith("Nothing to reset"));
    return { ok: code === 0, changed, lines: summary };
}

function activeReleaseProblem(): string | undefined {
    const prefix = runningInstallPrefix();
    if (prefix === undefined) return undefined;
    const buildId = currentReleaseBuildId(prefix);
    if (buildId === undefined) return "No release is active.";
    return releaseProblem(packedReleaseRoot(prefix), buildId);
}

function rollbackTarget(): { prefix: string; root: string; buildId: string } | undefined {
    const prefix = runningInstallPrefix();
    if (prefix === undefined) return undefined;
    const buildId = rollbackReleaseBuildId(prefix);
    if (buildId === undefined || buildId === currentReleaseBuildId(prefix)) return undefined;
    const root = releaseDirectory(buildId, prefix);
    if (releaseProblem(root, buildId) !== undefined) return undefined;
    return { prefix, root, buildId };
}

// A boot can wait on the user, so the lock lives in the home itself, outside the runtime folder a stash moves.
const BOOT_LOCK_MAX_AGE_MS = 15 * 60_000;

async function withBootLock<T>(run: () => Promise<T>, onWaiting?: (holderPid: number | undefined) => void): Promise<T> {
    const path = join(selectedVeraHome(), "boot.lock");
    let told = false;
    for (;;) {
        try {
            const claim = await acquireHostStartupClaim({ path, maxClaimAgeMs: BOOT_LOCK_MAX_AGE_MS });
            try {
                return await run();
            } finally {
                await claim.release().catch(() => {});
            }
        } catch (error) {
            if (!(error instanceof HostStartupInProgressError)) throw error;
            if (!told) {
                told = true;
                (onWaiting ?? ((pid) => process.stderr.write(`Another Vera${pid === undefined ? "" : ` (PID ${pid})`} is starting this home; waiting for it.\n`)))(error.holderPid);
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}

// Stops a host this boot started, so a stash can be put back under it.
async function stopStartedHost(record: HostLockRecord): Promise<void> {
    await gracefulStopResidentHost({});
    if (processIsAlive(record.pid)) await forceStopResidentHost({});
    if (processIsAlive(record.pid)) throw new Error(`Host PID ${record.pid} did not stop.`);
}

async function confirmBootQuestion(question: BootQuestion): Promise<boolean> {
    const { terminalCardPresenter } = await import("../cli/startup-prompt.ts");
    const cards = terminalCardPresenter();
    if (cards === undefined) return confirmOnTerminal(`${question.text} [Y/n] `, question.id !== "stop_answering_host");
    const { bootQuestionCard } = await import("../cli/boot-question-card.ts");
    return cards.ask(bootQuestionCard(question));
}

async function confirmOnTerminal(question: string, unattendedAnswer: boolean): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return unattendedAnswer;
    process.stderr.write(question);
    const answer = await new Promise<string | undefined>((resolve) => {
        const finish = (value: string | undefined) => {
            process.stdin.off("data", onData);
            process.stdin.off("end", onEnd);
            process.stdin.off("close", onEnd);
            process.stdin.off("error", onEnd);
            process.stdin.pause();
            resolve(value);
        };
        const onData = (chunk: Buffer | string) => finish(String(chunk).trim().toLowerCase());
        const onEnd = () => finish(undefined);
        process.stdin.once("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("close", onEnd);
        process.stdin.once("error", onEnd);
        process.stdin.resume();
    });
    return answer === undefined ? unattendedAnswer : answer === "" || answer === "y" || answer === "yes";
}

export function residentHostEntrypoint(): string {
    return fileURLToPath(new URL("./main.ts", import.meta.url));
}

export function residentHostSpawnSpec(
    releaseRoot: string | undefined = childReleaseRoot(),
    pool = false,
    mode: HostMode = "default",
): { readonly command: string; readonly args: readonly string[] } {
    const flags = mode === "single" ? ["--single-process"] : pool ? ["--pool"] : [];
    if (releaseRoot !== undefined) {
        const packed = releaseBinaryPath(RELEASE_HOST_NAME, releaseRoot);
        if (existsSync(packed)) {
            return { command: packed, args: flags };
        }
    }
    return { command: process.execPath, args: [residentHostEntrypoint(), ...flags] };
}

export function worktreeRuntimeNotice(
    cwd: string = process.cwd(),
    environment: Record<string, string | undefined> = process.env,
): string | undefined {
    const chosen = (environment[VERA_HOME_ENV] ?? "").trim().length > 0;
    if (chosen) return undefined;
    const root = linkedWorktreeRoot(cwd);
    if (root === undefined || !isVeraCheckout(root)) return undefined;
    return "started inside a Git worktree with no instance of its own, so this"
        + " session is attached to the daily host and does not run"
        + " this worktree's code. Quit and start it with"
        + " 'bun run dev:tui'.";
}

function linkedWorktreeRoot(cwd: string): string | undefined {
    let directory = resolve(cwd);
    for (;;) {
        const marker = statSync(join(directory, ".git"), {
            throwIfNoEntry: false,
        });
        if (marker !== undefined) return marker.isFile() ? directory : undefined;
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
}

// The advice names `bun run dev:tui`, so it is only right where that script exists in Vera's own package.
function isVeraCheckout(root: string): boolean {
    try {
        const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        if (typeof manifest !== "object" || manifest === null) return false;
        const { name, scripts } = manifest as { name?: unknown; scripts?: unknown };
        if (name !== "vera" || typeof scripts !== "object" || scripts === null) return false;
        return typeof (scripts as Record<string, unknown>)["dev:tui"] === "string";
    } catch {
        return false;
    }
}

function spawnDetachedResidentHost(pool = false, mode: HostMode = "default", releaseRoot?: string): Promise<void> {
    const failures = recentBootFailures(Date.now());
    if (failures.length >= BOOT_FAILURE_LIMIT) {
        return Promise.reject(new HostBootLoopError(failures.length, readHostStartupFailure(0)?.message));
    }
    const spawnedAt = Date.now();
    const spec = residentHostSpawnSpec(releaseRoot ?? childReleaseRoot(), pool, mode);
    const home = resolve(selectedVeraHome());
    const child = spawn(spec.command, [...spec.args], {
        argv0: "vera-host",
        cwd: home,
        env: hostLaunchEnvironment(home),
        detached: true,
        stdio: "ignore",
    });
    child.once("exit", (code) => {
        if (countsAsBootFailure(code, Date.now() - spawnedAt)) {
            recordBootFailure(Date.now());
        }
    });

    return new Promise((resolve, reject) => {
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}
