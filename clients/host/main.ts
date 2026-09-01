#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { renderCliFailure } from "../cli/main.ts";
import { loadOrCreateVeraConfig, VeraConfigError } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { installLiveProcess } from "../../src/live-process.ts";
import { installHostCrashGuard } from "./crash-guard.ts";
import { runResidentHostProcess } from "./process-lifecycle.ts";
import { clearBootFailures, HOST_STARTUP_RACE_EXIT_CODE } from "./launch.ts";
import {
    capturePinnedBuild,
    recordCleanBoot,
} from "../../src/host/pinned-build.ts";
import {
    anotherHostIsServing,
    isSupervisedHost,
    startWaitingOutRivals,
} from "./supervised-start.ts";

const entrypoint = fileURLToPath(import.meta.url);
const pinnedBuildCandidate = capturePinnedBuild(entrypoint);

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
    // Losing the startup race is another host winning it, which is a working
    // outcome for the user and must not be counted against the build. Its own
    // exit code separates it from a host that could not start at all.
    if (anotherHostIsServing(error)) {
        process.stderr.write(`${error.message}\n`);
        process.exit(HOST_STARTUP_RACE_EXIT_CODE);
    }
    throw error;
}

clearBootFailures();
installLiveProcess("host");
// The host is serving by now, which is what makes this commit worth pinning:
// the pin means "this build boots", never "this build is newest".
recordCleanBoot(pinnedBuildCandidate);
const removeCrashGuard = installHostCrashGuard();
await runResidentHostProcess(host, {
    stopAbsorbingFaults: removeCrashGuard,
});
