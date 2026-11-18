#!/usr/bin/env bun

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledRelease } from "../../src/release/runtime-path.ts";

import { renderCliFailure } from "../cli/failure.ts";
import { loadOrCreateVeraConfig, VeraConfigError } from "../../src/config.ts";
import {
    processIsDevelopmentInstance,
    registerDevInstance,
} from "../../src/dev-instances.ts";
import {
    HostLockUnreadableError,
    HOST_STARTUP_RACE_EXIT_CODE,
} from "../../src/host/lockfile.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { createHostLogger, createHostLogWriter, defaultHostLogPath, type HostLog } from "../../src/host/host-log.ts";
import { HostLifecycle } from "../../src/host/host-lifecycle.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { selectedVeraHome, VERA_HOME_ENV } from "../../src/profile-paths.ts";
import { installLiveProcess } from "../../src/live-process.ts";
import { waitForCheckoutRemoval } from "./checkout-watch.ts";
import { installHostCrashGuard } from "./crash-guard.ts";
import { waitForSocketLoss } from "./socket-watch.ts";
import { installStartupSignalLogging, runResidentHostProcess } from "./process-lifecycle.ts";
import { runPendingHandoff } from "../../src/release/handoff.ts";
import { clearBootFailures } from "./boot-failures.ts";
import {
    clearHostStartupFailure,
    homeCommandPrefix,
    hostHomeProblem,
    hostSocketPathProblem,
    recordHostStartupFailure,
} from "../../src/host/startup-failure.ts";
import {
    anotherHostIsServing,
    isSupervisedHost,
    startWaitingOutRivals,
} from "./supervised-start.ts";

const LOCK_RESET_ADVICE = "To back up this home's records, stop its Vera processes and clear the lock, run: ";

// Nobody reads this process's output, so the cause also goes where the launcher looks for it.
function failStartup(error: unknown, log?: HostLog): never {
    const text = error instanceof HostLockUnreadableError
        ? `${renderCliFailure(error)}\n${LOCK_RESET_ADVICE}${homeCommandPrefix()}vera host reset`
        : renderCliFailure(error);
    recordHostStartupFailure(text);
    logStartupFailure(error, "startup_failure", log);
    process.stderr.write(`${text}\n`);
    process.exit(1);
}

function logStartupFailure(error: unknown, reason: "startup_failure" | "startup_race" = "startup_failure", log?: HostLog): void {
    let buildId: string | undefined;
    try { buildId = thisProcessBuildId(); } catch {}
    (log ?? createHostLogger())({
        type: "host_stopping", role: "host", pid: process.pid, reason,
        started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        ...(buildId === undefined ? {} : { build_id: buildId }),
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
}

export async function runHostEntrypoint(): Promise<void> {
    let stopLog: HostLog | undefined;
    let removeStartupSignals = (): void => {};
    try {
        await startHostEntrypoint((log, removeSignals) => { stopLog = log; removeStartupSignals = removeSignals; });
    } catch (error) {
        logStartupFailure(error, "startup_failure", stopLog);
        throw error;
    } finally {
        removeStartupSignals();
    }
}

async function startHostEntrypoint(setStopLog: (log: HostLog, removeSignals: () => void) => void): Promise<void> {
    const blocker = hostHomeProblem() ?? hostSocketPathProblem();
    if (blocker !== undefined) failStartup(blocker);
    let config;
    try {
        config = loadOrCreateVeraConfig();
    } catch (error) {
        if (error instanceof VeraConfigError) failStartup(error);
        recordHostStartupFailure(renderCliFailure(error));
        throw error;
    }
    // A launching client's folder can be a worktree deleted later, and then every spawn fails with ENOENT.
    const home = resolve(selectedVeraHome());
    if (process.env[VERA_HOME_ENV] !== undefined) process.env[VERA_HOME_ENV] = home;
    process.chdir(home);
    const identity = {
        pid: process.pid,
        started_at: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        build_id: thisProcessBuildId(),
    };
    const writeLog = createHostLogWriter({ path: defaultHostLogPath(home) });
    const lifecycle = new HostLifecycle(home, identity, writeLog);
    const log: HostLog = (entry) => {
        const written = writeLog(entry);
        if (written && entry.type === "host_stopping" && entry.pid === identity.pid) lifecycle.stopRecorded();
    };
    const removeStartupSignals = installStartupSignalLogging(log, identity);
    setStopLog(log, removeStartupSignals);

    // --single-process is the launcher's fallback when the pooled host cannot start.
    const pool = config.host?.workers !== 0 && !process.argv.includes("--single-process");
    const skipStartupDiscovery = process.argv.includes("--no-discovery");
    if (skipStartupDiscovery && !processIsDevelopmentInstance()) {
        throw new Error("--no-discovery requires a development instance");
    }

    const start = (): ReturnType<typeof startResidentHost> =>
        startResidentHost({
            config,
            startedAt: identity.started_at,
            onHostClaimed: () => lifecycle.start(),
            processWorker: pool,
            ...(pool && config.host?.workers !== undefined ? { processWorkerCount: config.host.workers } : {}),
            ...(skipStartupDiscovery ? { skipStartupDiscovery: true } : {}),
        });

    let host;
    try {
        host = isSupervisedHost()
            ? await startWaitingOutRivals(start, {
                onWait: (error) => process.stderr.write(`${error.message}\n`),
            })
            : await start();
    } catch (error) {
        // Losing the startup race is another host winning it, which is a working outcome for the user and must not be counted against the build.
        if (anotherHostIsServing(error)) {
            logStartupFailure(error, "startup_race", log);
            process.stderr.write(`${error.message}\n`);
            process.exit(HOST_STARTUP_RACE_EXIT_CODE);
        }
        // A supervised host waits this out, so only an unsupervised start gets here.
        if (error instanceof HostLockUnreadableError) failStartup(error, log);
        recordHostStartupFailure(renderCliFailure(error));
        throw error;
    }

    clearBootFailures();
    clearHostStartupFailure();
    lifecycle.running();
    if (pool && process.argv.includes("--pool")) process.stdout.write("Session worker ready\n");
    installLiveProcess("host");
    const developmentSource = noteDevelopmentInstance();
    const removeCrashGuard = installHostCrashGuard(log, undefined, identity);
    const running = runResidentHostProcess(host, {
        identity,
        log,
        stopAbsorbingFaults: removeCrashGuard,
        waitForCheckoutRemoval: developmentSource === undefined
            ? undefined
            : () => waitForCheckoutRemoval(developmentSource),
        waitForSocketLoss: () => waitForSocketLoss(host.server.socketPath),
        afterClose: runPendingHandoff,
        ...(pool ? { poolWorkerPids: () => host.workerStopPids?.() ?? [] } : {}),
    });
    removeStartupSignals();
    await running;

}

if (import.meta.main) {
    await runHostEntrypoint();
}

/**
 * A candidate build gets its own home, so the homes outnumber the checkouts and
 * outlive them. The pointer is what a sweep reads to find them.
 */
function noteDevelopmentInstance(): string | undefined {
    if (isCompiledRelease()) return undefined;
    let source: string;
    try {
        source = fileURLToPath(import.meta.url);
        if (!processIsDevelopmentInstance()) return undefined;
    } catch {
        return undefined;
    }
    try {
        registerDevInstance({ source });
    } catch {
        // A home that cannot be pointed at still has to serve.
    }
    return source;
}
