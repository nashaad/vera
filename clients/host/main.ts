#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { renderCliFailure } from "../cli/main.ts";
import { loadOrCreateVeraConfig, VeraConfigError } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { runResidentHostProcess } from "./process-lifecycle.ts";

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

const host = await startResidentHost({
    config,
    entrypoint: fileURLToPath(import.meta.url),
});

await runResidentHostProcess(host);
