import { accessSync, constants, unlinkSync } from "node:fs";
import { join } from "node:path";

import { activateRelease } from "./activate.ts";
import {
    currentReleaseBuildId,
    prefixOfReleaseRoot,
    RELEASE_HOST_NAME,
    releaseDirectory,
    thisProcessReleaseRoot,
} from "./layout.ts";
import { readStampedRelease, thisProcessBuildId } from "./stamp.ts";
import { defaultEnsureHost, type EnsureHostOptions } from "./upgrade.ts";
import {
    defaultHostLockPath,
    readHostLockRecordFile,
    type HostLockRecord,
} from "../host/lockfile.ts";
import {
    stopResidentHostWhenIdle,
    type StopWhenIdleOptions,
    type StopWhenIdleOutcome,
} from "../host/force-stop.ts";
import type { StopWaitTarget } from "../host/stop-when-idle.ts";
import { checkRecordIdentity, processIsAlive } from "../host/process-identity.ts";

// Long enough for a cold start of the target host, or for the restore after a failed one.
export const HANDOFF_PUBLISH_TIMEOUT_MS = 30_000;
const HANDOFF_POLL_INTERVAL_MS = 100;

export { prefixOfReleaseRoot } from "./layout.ts";

// A release can start when its stamp names the build and its host binary runs.
export function releaseProblem(releaseRoot: string, buildId: string): string | undefined {
    try {
        const manifest = readStampedRelease(releaseRoot);
        if (manifest.build_id !== buildId) {
            return `Release ${buildId} at ${releaseRoot} is stamped ${manifest.build_id}.`;
        }
        accessSync(join(releaseRoot, RELEASE_HOST_NAME), constants.X_OK);
    } catch (error) {
        return `Release ${buildId} is not usable at ${releaseRoot}: ${errorText(error)}`;
    }
    return undefined;
}

// Runs in the host being replaced. A message means nothing was moved.
export function updateTargetProblem(buildId: string): string | undefined {
    const ownRoot = thisProcessReleaseRoot();
    const prefix = prefixOfReleaseRoot(ownRoot);
    if (prefix === undefined) {
        return "This host does not run from an installed release, so it cannot move to another build.";
    }
    if (buildId === thisProcessBuildId()) {
        return `This host already runs ${buildId}.`;
    }
    return releaseProblem(releaseDirectory(buildId, prefix), buildId);
}

export interface PendingHandoff {
    readonly prefix: string;
    readonly ownRoot: string;
    readonly ownBuildId: string;
    readonly buildId: string;
}

// One start attempt may take this long before it counts as failed, so the closed host always exits.
export const HANDOFF_ATTEMPT_TIMEOUT_MS = HANDOFF_PUBLISH_TIMEOUT_MS + 5_000;

let pendingHandoff: PendingHandoff | undefined;

// Called by StopWhenIdle once nothing waits. Moves current to the target, so the
// host started after this process exits runs the target build.
export function prepareStopForTarget(buildId: string | null): string | undefined {
    if (buildId === null) return undefined;
    const problem = updateTargetProblem(buildId);
    if (problem !== undefined) return problem;
    const ownRoot = thisProcessReleaseRoot();
    const prefix = prefixOfReleaseRoot(ownRoot);
    if (prefix === undefined) return "This host does not run from an installed release.";
    try {
        activateRelease(releaseDirectory(buildId, prefix), prefix);
    } catch (error) {
        return `Could not move current to ${buildId}: ${errorText(error)} The host keeps running.`;
    }
    pendingHandoff = { prefix, ownRoot, ownBuildId: thisProcessBuildId(), buildId };
    return undefined;
}

// Runs after the host closed and before it exits. Starts the target host with
// defaultEnsureHost; when the target does not publish, moves current back and
// starts this build again. Messages go to stderr, which the detached host discards.
export async function runPendingHandoff(
    ensureHost: (releaseRoot: string, options: EnsureHostOptions) => Promise<void> = defaultEnsureHost,
    report: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<void> {
    const handoff = pendingHandoff;
    if (handoff === undefined) return;
    pendingHandoff = undefined;
    await removeOwnLock();
    await runHandoff(handoff, {
        ensureHost,
        report,
        ...(process.argv.includes("--pool") ? { pool: true } : {}),
    });
}

export interface HandoffSteps {
    readonly ensureHost: (releaseRoot: string, options: EnsureHostOptions) => Promise<void>;
    readonly report: (line: string) => void;
    readonly activate?: (releaseRoot: string, prefix: string) => void;
    readonly pool?: boolean;
    readonly attemptTimeoutMs?: number;
}

// Ends with the target published, this build restored, or a report; it never waits past two attempts.
export async function runHandoff(handoff: PendingHandoff, steps: HandoffSteps): Promise<void> {
    const options: EnsureHostOptions = {
        publishTimeoutMs: HANDOFF_PUBLISH_TIMEOUT_MS,
        ...(steps.pool === true ? { pool: true } : {}),
    };
    const attemptMs = steps.attemptTimeoutMs ?? HANDOFF_ATTEMPT_TIMEOUT_MS;
    const activate = steps.activate ?? activateRelease;
    try {
        await withinDeadline(steps.ensureHost(releaseDirectory(handoff.buildId, handoff.prefix), options), attemptMs);
        return;
    } catch (error) {
        steps.report(`Vera could not start build ${handoff.buildId}: ${errorText(error)}`);
    }
    try {
        activate(handoff.ownRoot, handoff.prefix);
        await withinDeadline(steps.ensureHost(handoff.ownRoot, options), attemptMs);
        steps.report(`Vera restored build ${handoff.ownBuildId} and started its host.`);
    } catch (error) {
        steps.report(`Vera could not restore build ${handoff.ownBuildId}: ${errorText(error)}`);
    }
}

async function withinDeadline(attempt: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`The host start did not finish within ${ms} ms.`)), ms);
    });
    try {
        await Promise.race([attempt, expired]);
    } finally {
        clearTimeout(timer);
    }
}

// A closed host's lock still names its pid, which would refuse the next host.
async function removeOwnLock(lockPath = defaultHostLockPath()): Promise<void> {
    let record: HostLockRecord | undefined;
    try {
        record = await readHostLockRecordFile(lockPath);
    } catch {
        return;
    }
    if (record === undefined || record.pid !== process.pid) return;
    if (checkRecordIdentity(record) === "mismatch") return;
    try {
        unlinkSync(lockPath);
    } catch {
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export type HandOffOutcome =
    | { readonly kind: "updated"; readonly buildId: string }
    | { readonly kind: "accepted"; readonly buildId: string }
    | {
        readonly kind: "restored";
        readonly buildId: string;
        readonly runningBuildId: string | undefined;
        readonly message: string;
    }
    | {
        readonly kind: "no_host_started";
        readonly buildId: string;
        readonly currentBuildId: string | undefined;
        readonly message: string;
    }
    | { readonly kind: "not_moved"; readonly message: string };

export interface HandOffOptions {
    readonly buildId: string;
    readonly insideSession: boolean;
    readonly prefix?: string;
    readonly report: (line: string) => void;
    readonly stopHost?: (options: StopWhenIdleOptions) => Promise<StopWhenIdleOutcome | undefined>;
    readonly readLiveHost?: () => Promise<HostLockRecord | undefined>;
    readonly timeoutMs?: number;
}

// Asks the running host to move to buildId once it is idle. Never signals it.
export async function handOffUpdate(options: HandOffOptions): Promise<HandOffOutcome> {
    const stop = options.stopHost ?? stopResidentHostWhenIdle;
    let announced = false;
    const outcome = await stop({
        targetBuildId: options.buildId,
        detach: options.insideSession,
        onWaiting: (waiting: readonly StopWaitTarget[]) => {
            if (options.insideSession) return;
            if (!announced) {
                announced = true;
                options.report("Waiting for running turns to end before the update.");
            }
            for (const target of waiting) {
                const line = target.name
                    ? `Waiting on ${target.name} (${target.session_id}, ${target.status})`
                    : `Waiting on ${target.session_id} (${target.status})`;
                options.report(line);
            }
        },
    });
    if (outcome === undefined) {
        return { kind: "not_moved", message: "No resident Vera host is running; nothing was moved." };
    }
    switch (outcome.endedBy) {
        case "accepted":
            return { kind: "accepted", buildId: options.buildId };
        case "stopped":
            return awaitTargetHost(options, outcome.pid);
        case "abandoned":
        case "refused":
            return {
                kind: "not_moved",
                message: `${outcome.message ?? "The host refused the update."} The running host is still up and current was not moved.`,
            };
        case "no_answer":
            return {
                kind: "not_moved",
                message: `Resident Vera host PID ${outcome.pid} did not answer the update, so it was left running and current was not moved. Run 'vera host stop' and install again.`,
            };
        case "unsupported":
            return {
                kind: "not_moved",
                message: `Resident Vera host PID ${outcome.pid} is a build that cannot wait for turns, so it was left running and current was not moved. Run 'vera host stop' and install again.`,
            };
        case "still_running":
        case "timed_out":
        case "sigterm":
        case "sigkill":
        case "already_dead":
        case "survived":
        case "not_ours":
        case "unverified":
            return { kind: "not_moved", message: "The update did not start; current was not moved." };
    }
}

// Two attempts can run in turn (the target, then the restore), so the wait covers both.
async function awaitTargetHost(
    options: HandOffOptions,
    previousPid: number | undefined,
): Promise<HandOffOutcome> {
    const readLive = options.readLiveHost ?? defaultReadLiveHost;
    const timeoutMs = options.timeoutMs ?? 2 * HANDOFF_ATTEMPT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let running: string | undefined;
    while (Date.now() < deadline) {
        const live = await readLive();
        if (live !== undefined && live.build_id === options.buildId) {
            return { kind: "updated", buildId: options.buildId };
        }
        // A host other than the one that stopped means the target failed and the old build came back.
        if (live !== undefined && live.pid !== previousPid) {
            running = live.build_id;
            return {
                kind: "restored",
                buildId: options.buildId,
                runningBuildId: running,
                message: `The new host for ${options.buildId} did not start; build ${running} was restored and is running.`,
            };
        }
        await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_INTERVAL_MS));
    }
    const seconds = Math.round(timeoutMs / 1000);
    const currentBuildId = currentReleaseBuildId(options.prefix);
    return {
        kind: "no_host_started",
        buildId: options.buildId,
        currentBuildId,
        message: `No Vera host started within ${seconds} seconds. current names ${currentBuildId ?? "no build"}. Run 'vera' to start it.`,
    };
}

export async function defaultReadLiveHost(): Promise<HostLockRecord | undefined> {
    let record: HostLockRecord | undefined;
    try {
        record = await readHostLockRecordFile(defaultHostLockPath());
    } catch {
        return undefined;
    }
    if (record === undefined || !processIsAlive(record.pid)) return undefined;
    // A pid the OS reused for another process is not the host the lock names.
    return checkRecordIdentity(record) !== "mismatch" ? record : undefined;
}
