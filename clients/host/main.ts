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
import { selectedVeraHome, VERA_HOME_ENV } from "../../src/profile-paths.ts";
import { installLiveProcess } from "../../src/live-process.ts";
import { waitForCheckoutRemoval } from "./checkout-watch.ts";
import { installHostCrashGuard } from "./crash-guard.ts";
import { waitForSocketLoss } from "./socket-watch.ts";
import { runResidentHostProcess } from "./process-lifecycle.ts";
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
function failStartup(error: unknown): never {
    const text = error instanceof HostLockUnreadableError
        ? `${renderCliFailure(error)}\n${LOCK_RESET_ADVICE}${homeCommandPrefix()}vera host reset`
        : renderCliFailure(error);
    recordHostStartupFailure(text);
    process.stderr.write(`${text}\n`);
    process.exit(1);
}

export async function runHostEntrypoint(): Promise<void> {
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

    // --single-process is the launcher's fallback when the pooled host cannot start.
    const pool = config.host?.workers !== 0 && !process.argv.includes("--single-process");
    const skipStartupDiscovery = process.argv.includes("--no-discovery");
    if (skipStartupDiscovery && !processIsDevelopmentInstance()) {
        throw new Error("--no-discovery requires a development instance");
    }

    const start = (): ReturnType<typeof startResidentHost> =>
        startResidentHost({
            config,
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
            process.stderr.write(`${error.message}\n`);
            process.exit(HOST_STARTUP_RACE_EXIT_CODE);
        }
        // A supervised host waits this out, so only an unsupervised start gets here.
        if (error instanceof HostLockUnreadableError) failStartup(error);
        recordHostStartupFailure(renderCliFailure(error));
        throw error;
    }

    clearBootFailures();
    clearHostStartupFailure();
    if (pool && process.argv.includes("--pool")) process.stdout.write("Session worker ready\n");
    installLiveProcess("host");
    const developmentSource = noteDevelopmentInstance();
    const removeCrashGuard = installHostCrashGuard();
    await runResidentHostProcess(host, {
        stopAbsorbingFaults: removeCrashGuard,
        waitForCheckoutRemoval: developmentSource === undefined
            ? undefined
            : () => waitForCheckoutRemoval(developmentSource),
        waitForSocketLoss: () => waitForSocketLoss(host.server.socketPath),
        afterClose: runPendingHandoff,
        ...(pool ? { poolWorkerPids: () => host.workerStopPids?.() ?? [] } : {}),
    });

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
