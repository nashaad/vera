#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { renderCliFailure } from "../cli/main.ts";
import { loadVeraConfig, VeraConfigError } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

let config;
try {
    config = loadVeraConfig();
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

try {
    await waitForShutdownSignal();
} finally {
    await host.close();
}

function waitForShutdownSignal(): Promise<void> {
    return new Promise((resolve) => {
        const stop = (): void => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}
