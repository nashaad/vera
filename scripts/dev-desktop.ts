#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { assertDistinctSockets, cloneVeraHome } from "../src/host/home-clone.ts";
import { checkpointStoresThroughHost } from "../src/host/store-checkpoint-client.ts";
import {
    candidateBuildId,
    candidateHomePath,
    candidateLaunchEnv,
    dropClonedSchedules,
    factoryHomePath,
    liftCloneHome,
    quarantineUnknownHomeEntries,
    resolveLinkedWorktreeRoot,
} from "./dev-tui.ts";

const args = process.argv.slice(2);
const homeOnly = args.includes("--home-only");
const skipBuild = args.includes("--no-build");
const root = resolveLinkedWorktreeRoot(process.cwd());
const sourceHome = factoryHomePath(root);
const home = candidateHomePath(root);
const buildId = candidateBuildId(root);

if (!existsSync(home)) {
    if (!existsSync(sourceHome)) {
        console.error(
            `Factory home is missing at ${sourceHome}. `
            + "Synthesize it with bun run factory:home.",
        );
        process.exit(1);
    }
    mkdirSync(dirname(home), { recursive: true, mode: 0o700 });
    await cloneVeraHome({ sourceHome, destinationHome: home });
    const dailySocket = join(sourceHome, "runtime", "host.sock");
    if (existsSync(dailySocket)) {
        try {
            await checkpointStoresThroughHost(dailySocket, join(home, "runtime"));
        } catch (error) {
            console.error(
                `Checkpoint failed; clone refused: ${error instanceof Error ? error.message : String(error)}`,
            );
            process.exit(1);
        }
    }
    dropClonedSchedules(home);
}
const lifted = liftCloneHome(home);
if (lifted) dropClonedSchedules(home);
quarantineUnknownHomeEntries(home);
assertDistinctSockets(home, sourceHome);

console.log(`Home: ${home}`);
console.log(`Build: ${buildId}`);
console.log(`CLI: ${join(root, "clients", "cli", "main.ts")}`);

if (homeOnly) process.exit(0);

if (!skipBuild) {
    const built = spawnSync(process.execPath, [join(root, "clients", "desktop", "build.ts")], {
        cwd: root,
        stdio: "inherit",
    });
    if (built.status !== 0) process.exit(built.status ?? 1);
}

let electron: string;
try {
    electron = createRequire(join(root, "clients", "desktop", "package.json"))("electron") as string;
} catch {
    console.error("Electron is not installed. Run: bun install --cwd clients/desktop");
    process.exit(1);
}

const env = candidateLaunchEnv(home, root, buildId);
env.VERA_DESKTOP_DEV_CLI = join(root, "clients", "cli", "main.ts");
env.VERA_DESKTOP_BUN = process.execPath;

const child = spawn(electron, [join(root, "clients", "desktop")], {
    cwd: root,
    env,
    stdio: "inherit",
});
child.once("exit", (code, signal) => {
    if (signal !== null) process.exit(1);
    process.exit(code ?? 1);
});
