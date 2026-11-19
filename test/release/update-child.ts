import { existsSync, writeFileSync } from "node:fs";

import { installRelease } from "../../src/release/install.ts";
import { currentReleaseBuildId, releaseDirectory } from "../../src/release/layout.ts";
import { rollbackLocalInstall } from "../../src/release/rollback.ts";
import { readStampedRelease } from "../../src/release/stamp.ts";
import { runUpdateJson } from "../../src/release/update-json.ts";

// Runs one update or rollback against an on-disk prefix in its own process, so a kill step can end it for real.
export interface ChildConfig {
    readonly mode: "update" | "download-only" | "rollback";
    readonly prefix: string;
    readonly api: string;
    readonly base: string;
    // With a gate, the switch waits for the file to exist and says so by writing `${gate}.ready` first.
    readonly gate?: string;
}

const config = JSON.parse(process.argv[2] ?? "{}") as ChildConfig;

function waitFor(path: string): Promise<void> {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            if (existsSync(path)) {
                clearInterval(timer);
                resolve();
            }
        }, 20);
    });
}

if (config.mode === "rollback") {
    const outcome = await rollbackLocalInstall(config.prefix, {
        drainHost: async () => "absent",
        startHost: async () => undefined,
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    process.exit(0);
}

const buildId = currentReleaseBuildId(config.prefix) ?? "";
const running = {
    root: releaseDirectory(buildId, config.prefix),
    prefix: config.prefix,
    version: readStampedRelease(releaseDirectory(buildId, config.prefix)).product_version,
    buildId,
};
const code = await runUpdateJson({
    prefix: config.prefix,
    running,
    platform: "darwin",
    arch: "arm64",
    releasesApi: config.api,
    downloadBase: config.base,
    downloadOnly: config.mode === "download-only",
    install: async (options) => {
        if (config.gate !== undefined) {
            writeFileSync(`${config.gate}.ready`, "1");
            await waitFor(config.gate);
        }
        return await installRelease({ ...options, readLiveHost: async () => undefined });
    },
});
process.exit(code);
