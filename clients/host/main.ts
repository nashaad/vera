#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

const host = await startResidentHost({
    config: loadVeraConfig(),
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
