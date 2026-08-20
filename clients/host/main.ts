#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { renderCliFailure } from "../cli/main.ts";
import { loadOrCreateVeraConfig, VeraConfigError } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { runResidentHostProcess } from "./process-lifecycle.ts";
import { installHostCrashGuard } from "./crash-guard.ts";
import { clearBootFailures, HOST_STARTUP_RACE_EXIT_CODE } from "./launch.ts";
import { HostStartupInProgressError } from "../../src/host/startup-claim.ts";

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

let host;
try {
    host = await startResidentHost({
        config,
        entrypoint: fileURLToPath(import.meta.url),
    });
} catch (error) {
    // Losing the startup race is another host winning it, which is a working
    // outcome for the user and must not be counted against the build. Its own
    // exit code separates it from a host that could not start at all.
    if (error instanceof HostStartupInProgressError) {
        process.stderr.write(`${error.message}\n`);
        process.exit(HOST_STARTUP_RACE_EXIT_CODE);
    }
    throw error;
}

clearBootFailures();
const removeCrashGuard = installHostCrashGuard();
await runResidentHostProcess(host, {
    stopAbsorbingFaults: removeCrashGuard,
});
