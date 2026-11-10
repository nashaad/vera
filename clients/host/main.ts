#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

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
import { installLiveProcess } from "../../src/live-process.ts";
import { waitForCheckoutRemoval } from "./checkout-watch.ts";
import { installHostCrashGuard } from "./crash-guard.ts";
import { waitForSocketLoss } from "./socket-watch.ts";
import { runResidentHostProcess } from "./process-lifecycle.ts";
import { runPendingHandoff } from "../../src/release/handoff.ts";
import { clearBootFailures } from "./boot-failures.ts";
import {
    anotherHostIsServing,
    isSupervisedHost,
    startWaitingOutRivals,
} from "./supervised-start.ts";

let config;
try {
    config = loadOrCreateVeraConfig();
} catch (error) {
    if (error instanceof VeraConfigError) {
        process.stderr.write(`${renderCliFailure(error)}\n`);
        process.exit(1);
    }
    throw error;
}

const pool = config.host?.workers !== 0;
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
    if (error instanceof HostLockUnreadableError) {
        process.stderr.write(`${renderCliFailure(error)}\n`);
        process.exit(1);
    }
    throw error;
}

clearBootFailures();
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

/**
 * A candidate build gets its own home, so the homes outnumber the checkouts and
 * outlive them. The pointer is what a sweep reads to find them.
 */
function noteDevelopmentInstance(): string | undefined {
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
