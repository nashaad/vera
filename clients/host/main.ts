#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { renderCliFailure } from "../cli/main.ts";
import { loadOrCreateVeraConfig, VeraConfigError } from "../../src/config.ts";
import {
    processIsDevelopmentInstance,
    registerDevInstance,
} from "../../src/dev-instances.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { installLiveProcess } from "../../src/live-process.ts";
import { installHostCrashGuard } from "./crash-guard.ts";
import { runResidentHostProcess } from "./process-lifecycle.ts";
import { clearBootFailures, HOST_STARTUP_RACE_EXIT_CODE } from "./launch.ts";
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

const start = (): ReturnType<typeof startResidentHost> =>
    startResidentHost({
        config,
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
    throw error;
}

clearBootFailures();
installLiveProcess("host");
noteDevelopmentInstance();
const removeCrashGuard = installHostCrashGuard();
await runResidentHostProcess(host, {
    stopAbsorbingFaults: removeCrashGuard,
});

/**
 * A candidate build gets its own home, so the homes outnumber the checkouts and
 * outlive them. The pointer is what a sweep reads to find them.
 */
function noteDevelopmentInstance(): void {
    try {
        const source = fileURLToPath(import.meta.url);
        if (!processIsDevelopmentInstance(source)) return;
        registerDevInstance({ source });
    } catch {
        // A home that cannot be pointed at still has to serve.
    }
}
