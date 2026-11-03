import { spawn, type ChildProcess } from "node:child_process";
import {
    mkdirSync,
    readlinkSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

import { activateRelease } from "./activate.ts";
import {
    currentReleaseBuildId,
    defaultInstallPrefix,
    launcherPath,
    packedReleaseRoot,
    RELEASE_HOST_NAME,
    releaseDirectory,
    upgradeJournalPath,
    userHome,
} from "./layout.ts";
import type { ReleaseManifest } from "./manifest.ts";
import { readStampedRelease } from "./stamp.ts";
import { verifyPackedRelease } from "./verify.ts";
import {
    defaultHostLockPath,
    HOST_STARTUP_RACE_EXIT_CODE,
    HostLockUnreadableError,
    inspectHostLockFile,
    inspectHostLockFileSync,
    readHostLockRecordFile,
    refuseDamagedHostLock,
    type HostLockRecord,
} from "../host/lockfile.ts";
import {
    defaultKill,
    forceStopHostProcess,
    gracefulStopResidentHost,
    unverifiedHostMessage,
    type ForceStopOptions,
} from "../host/force-stop.ts";
import { checkRecordIdentity } from "../host/process-identity.ts";
import { veraHomeDirectory } from "../profile-paths.ts";

export type UpgradePhase = "draining" | "activating" | "starting";

// Names the command a message tells the user to run again.
export type UpgradeOperation = "install" | "rollback";

function retryCommand(operation: UpgradeOperation): string {
    return operation === "rollback" ? "'vera rollback'" : "'bun run install:local'";
}

function unchangedReleaseNote(operation: UpgradeOperation): string {
    return operation === "rollback"
        ? "Nothing was rolled back."
        : "The previous release is still active.";
}

// Same two fields as a host lock record, so the same identity check applies.
export interface RecordedHost {
    readonly pid: number;
    readonly started_at: string;
}

export interface UpgradeJournal {
    readonly phase: UpgradePhase;
    readonly from_build_id: string | null;
    readonly to_build_id: string;
    readonly host_was_running: boolean;
    // Starting the new host failed: recovery restores the previous release.
    readonly start_failed?: boolean;
    // A host this install started and could not stop.
    readonly surviving_host?: RecordedHost;
    // A host launched and not yet counted as started or stopped.
    readonly launched_host?: RecordedHost;
}

// Tells the journal about a launched host so a dead installer cannot lose it.
export interface HostLaunchRecorder {
    readonly launched: (host: RecordedHost) => Promise<void>;
    readonly resolved: () => Promise<void>;
}

export type StartHost = (
    releaseRoot: string,
    recorder: HostLaunchRecorder,
) => Promise<void>;

export interface UpgradeLocalOptions {
    readonly prefix?: string;
    readonly pack: () => Promise<{
        readonly prefix: string;
        readonly releaseRoot: string;
        readonly manifest: ReleaseManifest;
    }>;
    readonly verify?: (releaseRoot: string) => void;
    readonly drainHost?: () => Promise<"stopped" | "absent">;
    readonly startHost?: StartHost;
    readonly operation?: UpgradeOperation;
}

export interface UpgradedLocal {
    readonly prefix: string;
    readonly releaseRoot: string;
    readonly launcher: string;
    readonly current: string;
    readonly fromBuildId: string | null;
    readonly manifest: ReleaseManifest;
}

const PHASES = new Set<UpgradePhase>(["draining", "activating", "starting"]);

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function readUpgradeJournal(
    prefix = defaultInstallPrefix(),
): Promise<UpgradeJournal | undefined> {
    const path = upgradeJournalPath(prefix);
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(
            `Upgrade journal at ${path} is unreadable: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        throw new Error(
            `Upgrade journal at ${path} is not JSON: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Upgrade journal at ${path} must be an object`);
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.phase !== "string" || !PHASES.has(record.phase as UpgradePhase)) {
        throw new Error(`Upgrade journal at ${path} has an unknown phase`);
    }
    if (record.from_build_id !== null && typeof record.from_build_id !== "string") {
        throw new Error(`Upgrade journal at ${path} has a bad from_build_id`);
    }
    if (typeof record.to_build_id !== "string" || record.to_build_id.length === 0) {
        throw new Error(`Upgrade journal at ${path} has a bad to_build_id`);
    }
    if (typeof record.host_was_running !== "boolean") {
        throw new Error(`Upgrade journal at ${path} has a bad host_was_running`);
    }
    if (record.start_failed !== undefined && typeof record.start_failed !== "boolean") {
        throw new Error(`Upgrade journal at ${path} has a bad start_failed`);
    }
    const survivor = parseRecordedHost(record.surviving_host);
    if (survivor === null) {
        throw new Error(`Upgrade journal at ${path} has a bad surviving_host`);
    }
    const launched = parseRecordedHost(record.launched_host);
    if (launched === null) {
        throw new Error(`Upgrade journal at ${path} has a bad launched_host`);
    }
    return {
        phase: record.phase as UpgradePhase,
        from_build_id: record.from_build_id,
        to_build_id: record.to_build_id,
        host_was_running: record.host_was_running,
        ...(record.start_failed === true ? { start_failed: true } : {}),
        ...(survivor === undefined ? {} : { surviving_host: survivor }),
        ...(launched === undefined ? {} : { launched_host: launched }),
    };
}

// undefined: absent. null: present but not a pid and a start time.
function parseRecordedHost(value: unknown): RecordedHost | undefined | null {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const host = value as Record<string, unknown>;
    if (
        typeof host.pid !== "number"
        || !Number.isInteger(host.pid)
        || host.pid <= 0
        || typeof host.started_at !== "string"
        || Number.isNaN(Date.parse(host.started_at))
    ) {
        return null;
    }
    return { pid: host.pid, started_at: host.started_at };
}

function recordedHostJson(host: RecordedHost): RecordedHost {
    return { pid: host.pid, started_at: host.started_at };
}

export function writeUpgradeJournal(
    journal: UpgradeJournal,
    prefix = defaultInstallPrefix(),
): void {
    const path = upgradeJournalPath(prefix);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
        temporary,
        `${JSON.stringify({
            phase: journal.phase,
            from_build_id: journal.from_build_id,
            to_build_id: journal.to_build_id,
            host_was_running: journal.host_was_running,
            ...(journal.start_failed === true ? { start_failed: true } : {}),
            ...(journal.surviving_host === undefined
                ? {}
                : { surviving_host: recordedHostJson(journal.surviving_host) }),
            ...(journal.launched_host === undefined
                ? {}
                : { launched_host: recordedHostJson(journal.launched_host) }),
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o644 },
    );
    renameSync(temporary, path);
}

export async function clearUpgradeJournal(
    prefix = defaultInstallPrefix(),
): Promise<void> {
    try {
        await unlink(upgradeJournalPath(prefix));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

// "stopped" means a running host was stopped, so the new release starts one.
export async function defaultDrainHost(
    operation: UpgradeOperation = "install",
): Promise<"stopped" | "absent"> {
    const outcome = await gracefulStopResidentHost().catch((error: unknown) => {
        if (!(error instanceof HostLockUnreadableError)) throw error;
        throw new Error(
            `${error.message} Run ${retryCommand(operation)} again. `
                + unchangedReleaseNote(operation),
        );
    });
    if (outcome === undefined) return "absent";
    switch (outcome.endedBy) {
        case "unverified":
            throw new Error(
                `${unverifiedHostMessage(outcome)} Run ${retryCommand(operation)}`
                    + ` again. ${unchangedReleaseNote(operation)}`,
            );
        case "survived":
            throw new Error(
                `Resident Vera host PID ${outcome.pid} is still running. `
                    + "Stop it with 'vera host stop --force' and run "
                    + `${retryCommand(operation)} again. `
                    + unchangedReleaseNote(operation),
            );
        case "already_dead":
        case "not_ours":
            return "absent";
        case "sigterm":
        case "sigkill":
            return "stopped";
    }
}

export interface EnsureHostOptions {
    readonly publishTimeoutMs?: number;
    readonly exitGraceMs?: number;
    readonly operation?: UpgradeOperation;
    readonly stopStartedHost?: (child: ChildProcess, graceMs: number) => Promise<boolean>;
    readonly recorder?: HostLaunchRecorder;
}

// Thrown when the host this command started cannot be stopped. Rolling back must
// not start the previous host next to it; host goes in the journal for the next run.
export class StartedHostSurvivedError extends Error {
    constructor(message: string, readonly host?: RecordedHost) {
        super(message);
        this.name = "StartedHostSurvivedError";
    }
}

// Another build's live host, or a damaged lockfile that may stand for one,
// blocks the start. Recovery leaves state alone; an install undoes its activation.
export class HostStartRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HostStartRefusedError";
    }
}

const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const UNPUBLISHED_HOST_EXIT_MS = 3_000;

const MAX_LINK_HOPS = 40;

// A VERA_HOME or prefix that is a symlink to the daily path must compare equal
// to it, even when the link dangles or the path does not exist yet.
function canonicalPath(path: string, hops = 0): string {
    const absolute = resolvePath(path);
    try {
        return realpathSync(absolute);
    } catch {
        // A missing or dangling component: resolve the parent, then follow a link.
    }
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const candidate = join(canonicalPath(parent, hops), basename(absolute));
    if (hops >= MAX_LINK_HOPS) return candidate;
    let target: string;
    try {
        target = readlinkSync(candidate);
    } catch {
        return candidate;
    }
    return canonicalPath(resolvePath(dirname(candidate), target), hops + 1);
}

// The daily prefix goes with the default home, and a test prefix with a private one.
function assertPrefixMayManageHost(
    prefix: string,
    operation: UpgradeOperation,
): void {
    const dailyPrefix = canonicalPath(prefix) === canonicalPath(defaultInstallPrefix());
    const selectedHome = veraHomeDirectory();
    const dailyHome = veraHomeDirectory(userHome());
    const selectsDailyHome = canonicalPath(selectedHome) === canonicalPath(dailyHome);
    if (dailyPrefix === selectsDailyHome) return;
    if (dailyPrefix) {
        throw new Error(
            `This ${operation} would switch the daily release under ${prefix} but `
                + `stop and start only the host of ${selectedHome}, which VERA_HOME `
                + `selects. Unset VERA_HOME for a daily ${operation}, or add --prefix `
                + `for a test ${operation}. Nothing was changed.`,
        );
    }
    throw new Error(
        `--prefix ${prefix} is a test prefix, and this ${operation} would stop and `
            + `start the host of the default Vera home, ${dailyHome}. `
            + `Set VERA_HOME to a private home for a test ${operation}. `
            + "Nothing was changed.",
    );
}

async function liveHostRecord(lockPath: string): Promise<HostLockRecord | undefined> {
    const record = await readHostLockRecordFile(lockPath);
    if (record === undefined || !processIsAlive(record.pid)) return undefined;
    return checkRecordIdentity(record) !== "mismatch" ? record : undefined;
}

function describeBuild(record: HostLockRecord): string {
    return record.build_id ?? "an unknown build";
}

function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
    if (hasExited(child)) return Promise.resolve(true);
    return new Promise<boolean>((done) => {
        const onExit = (): void => {
            clearTimeout(timer);
            done(true);
        };
        const timer = setTimeout(() => {
            child.off("exit", onExit);
            done(false);
        }, ms);
        child.once("exit", onExit);
    });
}

async function stopUnpublishedHost(child: ChildProcess, graceMs: number): Promise<boolean> {
    if (hasExited(child)) return true;
    child.kill("SIGTERM");
    if (await waitForExit(child, graceMs)) return true;
    child.kill("SIGKILL");
    return waitForExit(child, graceMs);
}

export async function defaultEnsureHost(
    releaseRoot: string,
    options: EnsureHostOptions = {},
): Promise<void> {
    const expected = readStampedRelease(releaseRoot).build_id;
    const retry = retryCommand(options.operation ?? "install");
    const lockPath = defaultHostLockPath();
    try {
        // Reading a damaged lock as "no host" would start a second host.
        refuseDamagedHostLock(await inspectHostLockFile(lockPath));
    } catch (error) {
        if (!(error instanceof HostLockUnreadableError)) throw error;
        throw new HostStartRefusedError(`${error.message} Run ${retry} again.`);
    }
    const existing = await liveHostRecord(lockPath);
    if (existing !== undefined) {
        if (existing.build_id === expected) return;
        throw new HostStartRefusedError(
            `Resident Vera host PID ${existing.pid} is running ${describeBuild(existing)}, `
                + `not ${expected}. Stop it with 'vera host stop' and run `
                + `${retry} again.`,
        );
    }
    const child = spawn(join(releaseRoot, RELEASE_HOST_NAME), [], {
        argv0: "vera-host",
        detached: true,
        stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
    const spawnedAt = new Date().toISOString();
    const childPid = child.pid;
    if (childPid === undefined) {
        throw new Error(`The host from ${releaseRoot} has no process id after it started.`);
    }
    const launched: RecordedHost = { pid: childPid, started_at: spawnedAt };
    const recorder = options.recorder;
    // A record left behind is checked against the lock and the process on the next run.
    const settle = async (): Promise<void> => {
        await recorder?.resolved().catch(() => undefined);
    };
    const stopLaunched = (): Promise<boolean> => (options.stopStartedHost ?? stopUnpublishedHost)(
        child,
        options.exitGraceMs ?? UNPUBLISHED_HOST_EXIT_MS,
    );
    const survived = (message: string): StartedHostSurvivedError =>
        new StartedHostSurvivedError(
            `${message}The host it started (PID ${childPid}) is still running and is `
                + `recorded in the upgrade journal; the next ${retry} stops it and starts `
                + "the host again.",
            launched,
        );
    const timeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let published: HostLockRecord | undefined;
    try {
        await recorder?.launched(launched);
        while (Date.now() < deadline) {
            published = await liveHostRecord(lockPath);
            if (published?.build_id === expected) {
                if (published.pid === childPid) {
                    await settle();
                    return;
                }
                // A rival on this build took the lock first and the child yielded to it.
                if (child.exitCode === HOST_STARTUP_RACE_EXIT_CODE) {
                    await settle();
                    return;
                }
            }
            await waitFor(50);
        }
    } catch (error) {
        // The host is running and the journal may not name it: stop it or report it.
        if (await stopLaunched()) {
            await settle();
            throw error;
        }
        throw survived(`${error instanceof Error ? error.message : String(error)} `);
    }
    // Still running at the deadline beside a same-build host: it never yielded.
    const waitingOnRival = !hasExited(child)
        && published?.build_id === expected
        && published.pid !== childPid;
    const stopped = await stopLaunched();
    if (stopped) await settle();
    if (waitingOnRival && stopped) {
        const serving = await liveHostRecord(lockPath);
        if (serving?.build_id === expected && serving.pid !== childPid) return;
    }
    const shows = published === undefined
        ? "no live host"
        : `host PID ${published.pid} on ${describeBuild(published)}`
            + (published.pid === childPid ? "" : `, not the host started here (PID ${childPid})`);
    const message = `The host from ${releaseRoot} did not publish build ${expected} in `
        + `${lockPath} within ${timeoutMs} ms; the lock shows ${shows}. `;
    if (stopped) throw new Error(`${message}The host it started was stopped.`);
    throw survived(message);
}

export async function recoverInterruptedUpgrade(
    options: {
        readonly prefix?: string;
        readonly startHost?: StartHost;
        readonly operation?: UpgradeOperation;
        readonly forceStop?: ForceStopOptions;
    } = {},
): Promise<{ readonly recovered: boolean; readonly buildId: string | undefined }> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const operation = options.operation ?? "install";
    const journal = await readUpgradeJournal(prefix);
    if (journal === undefined) {
        return { recovered: false, buildId: currentReleaseBuildId(prefix) };
    }
    // Before anything changes: a refusal from inside the start would read as a failed start.
    if (options.startHost === undefined) assertPrefixMayManageHost(prefix, operation);
    const startHost = recordingLaunches(
        prefix,
        options.startHost ?? ensureHostFor(operation),
    );
    if (journal.surviving_host !== undefined) {
        await stopRecordedHost(journal.surviving_host, operation, options.forceStop);
    }
    if (journal.launched_host !== undefined) {
        await stopLaunchedHost(journal.launched_host, operation, options.forceStop);
    }
    if (journal.phase === "starting" && journal.start_failed === true) {
        await restorePreviousRelease(
            prefix,
            journal.from_build_id,
            journal.host_was_running,
            startHost,
            { startedHostSurvived: false, clearJournalOnFailure: true },
        );
        return { recovered: true, buildId: currentReleaseBuildId(prefix) };
    }
    const live = currentReleaseBuildId(prefix);
    const current = live
        ?? (journal.phase === "starting" ? journal.to_build_id : journal.from_build_id)
        ?? undefined;
    // An install that died after it moved current but before it wrote "starting".
    const startsNewRelease = journal.phase === "starting"
        || (journal.phase === "activating" && current === journal.to_build_id);
    if (journal.host_was_running && current !== undefined) {
        try {
            await startHost(releaseDirectory(current, prefix));
        } catch (error) {
            if (!startsNewRelease || error instanceof HostStartRefusedError) {
                if (error instanceof StartedHostSurvivedError && error.host !== undefined) {
                    await recordSurvivingHost(prefix, error.host);
                }
                if (!startsNewRelease && live === journal.from_build_id && failsWithoutHost(error)) {
                    await failWithClearedJournal(prefix, error);
                }
                throw error;
            }
            // The new release's host will not start: undo the switch like the install would.
            writeUpgradeJournal(startFailedJournal(journal, error), prefix);
            const survived = error instanceof StartedHostSurvivedError;
            await restorePreviousRelease(
                prefix,
                journal.from_build_id,
                journal.host_was_running,
                startHost,
                { startedHostSurvived: survived, clearJournalOnFailure: true },
            );
            if (survived) throw error;
            return { recovered: true, buildId: currentReleaseBuildId(prefix) };
        }
    }
    await clearUpgradeJournal(prefix);
    return { recovered: true, buildId: current };
}

// The survivor is recorded only for a host this run started and could not stop.
function startFailedJournal(journal: UpgradeJournal, error: unknown): UpgradeJournal {
    return {
        phase: "starting",
        from_build_id: journal.from_build_id,
        to_build_id: journal.to_build_id,
        host_was_running: journal.host_was_running,
        start_failed: true,
        ...(error instanceof StartedHostSurvivedError && error.host !== undefined
            ? { surviving_host: error.host }
            : {}),
    };
}

class LaunchedHostServing extends Error {}

// A launched host that holds the lock is serving, so it is not stopped. The lock is
// read again right before each signal because the host may publish after the first read.
async function stopLaunchedHost(
    host: RecordedHost,
    operation: UpgradeOperation,
    options: ForceStopOptions | undefined,
): Promise<void> {
    const lockPath = options?.lockPath ?? defaultHostLockPath();
    const serving = await liveHostRecord(lockPath);
    if (serving?.pid === host.pid) return;
    const signal = options?.kill ?? defaultKill;
    try {
        await stopRecordedHost(host, operation, {
            ...options,
            // Only before SIGTERM: a host still alive after SIGTERM is stuck in close.
            kill: (pid, name) => {
                if (name === "SIGTERM") {
                    const lock = inspectHostLockFileSync(lockPath);
                    if (
                        lock.state === "valid"
                        && lock.record.pid === host.pid
                        && checkRecordIdentity(lock.record) !== "mismatch"
                    ) {
                        throw new LaunchedHostServing();
                    }
                }
                signal(pid, name);
            },
        });
    } catch (error) {
        if (!(error instanceof LaunchedHostServing)) throw error;
    }
}

async function stopRecordedHost(
    host: RecordedHost,
    operation: UpgradeOperation,
    options: ForceStopOptions | undefined,
): Promise<void> {
    const outcome = await forceStopHostProcess(host, options);
    switch (outcome.endedBy) {
        case "sigterm":
        case "sigkill":
        case "already_dead":
        case "not_ours":
            return;
        case "unverified":
            throw new Error(
                `Could not confirm PID ${host.pid} is the host an earlier install or `
                    + "rollback started (its start time is unreadable); left it running. "
                    + `Run ${retryCommand(operation)} again. Nothing was changed.`,
            );
        case "survived":
            throw new Error(
                `The host an earlier install or rollback started (PID ${host.pid}) is `
                    + "still running after SIGTERM and SIGKILL. Stop it with "
                    + `'kill -9 ${host.pid}' or wait for it to exit, then run `
                    + `${retryCommand(operation)} again. Nothing was changed.`,
            );
        default: {
            const unhandled: never = outcome.endedBy;
            throw new Error(`Unhandled stop outcome ${String(unhandled)}`);
        }
    }
}

async function recordSurvivingHost(
    prefix: string,
    host: RecordedHost,
): Promise<void> {
    const journal = await readUpgradeJournal(prefix);
    if (journal === undefined) return;
    // A survivor is recorded once: it is no longer a launch still waiting to resolve.
    const { launched_host: launched, ...rest } = journal;
    writeUpgradeJournal({
        ...rest,
        ...(launched === undefined || launched.pid === host.pid ? {} : { launched_host: launched }),
        surviving_host: host,
    }, prefix);
}

function ensureHostFor(operation: UpgradeOperation): StartHost {
    return (releaseRoot, recorder) => defaultEnsureHost(releaseRoot, { operation, recorder });
}

// Every launch this run makes is written to the journal under prefix.
function recordingLaunches(
    prefix: string,
    startHost: StartHost,
): (releaseRoot: string) => Promise<void> {
    const recorder: HostLaunchRecorder = {
        launched: async (host) => {
            const journal = await readUpgradeJournal(prefix);
            if (journal === undefined) return;
            writeUpgradeJournal({ ...journal, launched_host: host }, prefix);
        },
        resolved: async () => {
            const journal = await readUpgradeJournal(prefix);
            if (journal?.launched_host === undefined) return;
            const { launched_host: _cleared, ...rest } = journal;
            writeUpgradeJournal(rest, prefix);
        },
    };
    return (releaseRoot) => startHost(releaseRoot, recorder);
}

interface RestoreOptions {
    readonly startedHostSurvived: boolean;
    // Only recovery clears the journal; an install leaves it for the next run's recovery.
    readonly clearJournalOnFailure: boolean;
}

async function restorePreviousRelease(
    prefix: string,
    fromBuildId: string | null,
    hostWasRunning: boolean,
    startHost: (releaseRoot: string) => Promise<void>,
    options: RestoreOptions,
): Promise<void> {
    const current = currentReleaseBuildId(prefix);
    if (fromBuildId !== null && current !== fromBuildId) {
        activateRelease(releaseDirectory(fromBuildId, prefix), prefix);
    }
    // The journal stays, so the next install starts the host once the survivor is gone.
    if (options.startedHostSurvived) return;
    if (hostWasRunning && fromBuildId !== null) {
        try {
            await startHost(releaseDirectory(fromBuildId, prefix));
        } catch (error) {
            if (error instanceof StartedHostSurvivedError && error.host !== undefined) {
                await recordSurvivingHost(prefix, error.host);
            }
            if (options.clearJournalOnFailure && failsWithoutHost(error)) {
                await failWithClearedJournal(prefix, error);
            }
            throw error;
        }
    }
    await clearUpgradeJournal(prefix);
}

// A refusal changes nothing and a surviving host is recorded; neither is a plain failure.
function failsWithoutHost(error: unknown): boolean {
    return !(error instanceof HostStartRefusedError)
        && !(error instanceof StartedHostSurvivedError);
}

// The previous release is active and no host is left behind, so a kept journal
// would only make every later install and rollback fail the same way.
async function failWithClearedJournal(prefix: string, error: unknown): Promise<never> {
    await clearUpgradeJournal(prefix);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
        `${reason}${/[.!?]$/.test(reason) ? "" : "."} `
            + "The previous release stays active; the upgrade journal was cleared.",
        { cause: error },
    );
}

export async function upgradeLocalInstall(
    options: UpgradeLocalOptions,
): Promise<UpgradedLocal> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const operation = options.operation ?? "install";
    if (options.drainHost === undefined || options.startHost === undefined) {
        assertPrefixMayManageHost(prefix, operation);
    }
    const startWithRecord = options.startHost ?? ensureHostFor(operation);
    const startHost = recordingLaunches(prefix, startWithRecord);
    const drainHost = options.drainHost ?? (() => defaultDrainHost(operation));
    const verify = options.verify
        ?? ((releaseRoot: string) => verifyPackedRelease(releaseRoot, prefix));

    await recoverInterruptedUpgrade({ prefix, startHost: startWithRecord, operation });
    const fromBuildId = currentReleaseBuildId(prefix) ?? null;

    const packed = await options.pack();
    verify(packed.releaseRoot);

    let hostWasRunning = false;
    let startFailed = false;
    try {
        const existing = await readHostLockRecordFile();
        if (existing !== undefined && processIsAlive(existing.pid)) {
            writeUpgradeJournal({
                phase: "draining",
                from_build_id: fromBuildId,
                to_build_id: packed.manifest.build_id,
                host_was_running: true,
            }, prefix);
        }
        const drained = await drainHost();
        hostWasRunning = drained === "stopped";
        writeUpgradeJournal({
            phase: "activating",
            from_build_id: fromBuildId,
            to_build_id: packed.manifest.build_id,
            host_was_running: hostWasRunning,
        }, prefix);
        activateRelease(packed.releaseRoot, prefix);
        writeUpgradeJournal({
            phase: "starting",
            from_build_id: fromBuildId,
            to_build_id: packed.manifest.build_id,
            host_was_running: hostWasRunning,
        }, prefix);
        if (hostWasRunning) {
            try {
                await startHost(packed.releaseRoot);
            } catch (error) {
                startFailed = true;
                throw error;
            }
        }
        await clearUpgradeJournal(prefix);
        return {
            prefix,
            releaseRoot: packed.releaseRoot,
            launcher: launcherPath(prefix),
            current: packedReleaseRoot(prefix),
            fromBuildId,
            manifest: packed.manifest,
        };
    } catch (error) {
        try {
            // Written before the restore: if the restore dies, recovery must not
            // read this journal as a start that is still in progress.
            if (startFailed) {
                writeUpgradeJournal(startFailedJournal({
                    phase: "starting",
                    from_build_id: fromBuildId,
                    to_build_id: packed.manifest.build_id,
                    host_was_running: hostWasRunning,
                }, error), prefix);
            }
            await restorePreviousRelease(
                prefix,
                fromBuildId,
                hostWasRunning,
                startHost,
                {
                    startedHostSurvived: error instanceof StartedHostSurvivedError,
                    clearJournalOnFailure: false,
                },
            );
        } catch (restoreError) {
            const first = error instanceof Error ? error.message : String(error);
            const second = restoreError instanceof Error
                ? restoreError.message
                : String(restoreError);
            throw new Error(
                `${first} Restore of the previous release also failed: ${second}`,
            );
        }
        throw error;
    }
}
