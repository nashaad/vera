#!/usr/bin/env bun

import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
    assertDistinctSockets,
    cloneVeraHome,
    hashedInstanceRoot,
} from "../src/host/home-clone.ts";
import { forceStopResidentHost } from "../src/host/force-stop.ts";
import { processIsAlive } from "../src/host/process-identity.ts";
import {
    veraHomeDirectory,
} from "../src/profile-paths.ts";
import { checkpointStoresThroughHost } from "../src/host/store-checkpoint-client.ts";
import { releaseBuildId } from "../src/release/build-id.ts";

const CLI_ENTRYPOINT = fileURLToPath(
    new URL("../clients/cli/main.ts", import.meta.url),
);
const INSTANCE_META = "dev-instance.json";

export type DevTuiAction = "run" | "status" | "stop" | "discard";

export interface DevTuiRequest {
    readonly action: DevTuiAction;
    readonly fresh: boolean;
    readonly yes: boolean;
    readonly passthrough: readonly string[];
}

export interface DevInstanceMeta {
    readonly worktree: string;
    readonly buildId: string;
    readonly sourceHome: string;
    readonly snapshotAt: string;
}

export function parseDevTuiArgs(args: readonly string[]): DevTuiRequest {
    let action: DevTuiAction = "run";
    let fresh = false;
    let yes = false;
    const passthrough: string[] = [];
    for (const arg of args) {
        if (arg === "--status") action = "status";
        else if (arg === "--stop") action = "stop";
        else if (arg === "--discard") action = "discard";
        else if (arg === "--fresh") fresh = true;
        else if (arg === "--yes") yes = true;
        else passthrough.push(arg);
    }
    return { action, fresh, yes, passthrough };
}

export function candidateHomePath(
    worktreeRoot: string,
    temporaryRoot = join(tmpdir(), "vera-dev"),
): string {
    return join(
        hashedInstanceRoot(realpathSync(worktreeRoot), temporaryRoot),
        ".vera",
    );
}

export function disableOutboundConsumers(home: string): void {
    const path = join(home, "config.json");
    if (!existsSync(path)) return;
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const experimental = typeof config.experimental === "object"
            && config.experimental !== null
            && !Array.isArray(config.experimental)
        ? { ...config.experimental as Record<string, unknown> }
        : {};
    experimental.inbox = false;
    config.experimental = experimental;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function formatDevInstanceMarker(
    worktreeRoot: string,
    buildId: string,
): string {
    return `[DEV ${basename(worktreeRoot)} ${buildId}]`;
}

export function readInstanceMeta(home: string): DevInstanceMeta | undefined {
    const path = join(home, "runtime", INSTANCE_META);
    if (!existsSync(path)) return undefined;
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as DevInstanceMeta;
        if (
            typeof value.worktree !== "string"
            || typeof value.buildId !== "string"
            || typeof value.sourceHome !== "string"
            || typeof value.snapshotAt !== "string"
        ) {
            return undefined;
        }
        return value;
    } catch {
        return undefined;
    }
}

function writeInstanceMeta(home: string, meta: DevInstanceMeta): void {
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    writeFileSync(
        join(home, "runtime", INSTANCE_META),
        `${JSON.stringify(meta, null, 2)}\n`,
        { mode: 0o600 },
    );
}

export function resolveLinkedWorktreeRoot(cwd: string): string {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        const reason = result.stderr.toString().trim();
        throw new Error(reason || `${cwd} is not inside a Git checkout`);
    }
    const root = realpathSync(result.stdout.toString().trim());
    if (!statSync(join(root, ".git")).isFile()) {
        throw new Error(
            `${root} is the main checkout; bun run dev:tui requires a linked worktree`,
        );
    }
    return root;
}

export function candidateBuildId(worktreeRoot: string): string {
    try {
        return releaseBuildId(worktreeRoot);
    } catch {
        return "unstamped";
    }
}

export interface DevTuiDependencies {
    readonly stdout?: { write(text: string): unknown };
    readonly stderr?: { write(text: string): unknown };
    readonly confirm?: (question: string) => Promise<boolean>;
    readonly spawnTui?: (
        args: readonly string[],
        env: NodeJS.ProcessEnv,
        cwd: string,
    ) => Promise<number>;
    readonly checkpointDaily?: (
        socketPath: string,
        destination: string,
    ) => Promise<void>;
    readonly temporaryRoot?: string;
    readonly sourceHome?: string;
}

export async function runDevTui(
    args: readonly string[],
    cwd = process.cwd(),
    dependencies: DevTuiDependencies = {},
): Promise<number> {
    const request = parseDevTuiArgs(args);
    const worktreeRoot = resolveLinkedWorktreeRoot(cwd);
    const sourceHome = dependencies.sourceHome ?? veraHomeDirectory();
    const temporaryRoot = dependencies.temporaryRoot ?? join(tmpdir(), "vera-dev");
    const instanceRoot = hashedInstanceRoot(
        realpathSync(worktreeRoot),
        temporaryRoot,
    );
    const destinationHome = join(instanceRoot, ".vera");
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;

    if (request.action === "status") {
        stdout.write(formatStatus(worktreeRoot, sourceHome, destinationHome));
        return 0;
    }
    if (request.action === "stop") {
        return await stopCandidate(destinationHome, stderr);
    }
    if (request.action === "discard") {
        const confirm = dependencies.confirm ?? confirmDiscard;
        if (!request.yes && !await confirm(
            `Discard the development instance at ${destinationHome}?`,
        )) {
            stderr.write("Kept the development instance.\n");
            return 0;
        }
        await stopCandidate(destinationHome, stderr);
        rmSync(instanceRoot, { recursive: true, force: true });
        stdout.write(`Discarded ${destinationHome}\n`);
        return 0;
    }

    if (existsSync(destinationHome) && request.fresh) {
        const confirm = dependencies.confirm ?? confirmDiscard;
        if (!request.yes && !await confirm(
            `Replace the development instance at ${destinationHome}?`,
        )) {
            stderr.write("Kept the existing development instance.\n");
            return 0;
        }
        await stopCandidate(destinationHome, stderr);
        rmSync(destinationHome, { recursive: true, force: true });
    }

    if (!existsSync(destinationHome)) {
        mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
        try {
            await cloneVeraHome({
                sourceHome,
                destinationHome,
            });
        } catch (error) {
            throw new Error(
                `Could not clone ${sourceHome} into ${destinationHome}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        disableOutboundConsumers(destinationHome);
        const dailySocket = join(sourceHome, "runtime", "host.sock");
        if (dailyHostAppearsRunning(sourceHome) && existsSync(dailySocket)) {
            try {
                await (dependencies.checkpointDaily ?? checkpointStoresThroughHost)(
                    dailySocket,
                    join(destinationHome, "runtime"),
                );
            } catch (error) {
                rmSync(destinationHome, { recursive: true, force: true });
                throw new Error(
                    `Checkpoint failed; clone refused: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        writeInstanceMeta(destinationHome, {
            worktree: worktreeRoot,
            buildId: candidateBuildId(worktreeRoot),
            sourceHome,
            snapshotAt: new Date().toISOString(),
        });
        assertDistinctSockets(destinationHome, sourceHome);
    }

    const buildId = readInstanceMeta(destinationHome)?.buildId
        ?? candidateBuildId(worktreeRoot);
    const spawn = dependencies.spawnTui ?? spawnWorktreeTui;
    return await spawn(
        request.passthrough,
        candidateLaunchEnv(destinationHome, worktreeRoot, buildId),
        worktreeRoot,
    );
}

export function candidateLaunchEnv(
    destinationHome: string,
    worktreeRoot: string,
    buildId: string,
    base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env = { ...base };
    delete env.VERA_RUNTIME_DIR;
    delete env.VERA_WORKTREE_RUNTIME;
    env.VERA_HOME = destinationHome;
    env.VERA_DEV_INSTANCE = `${basename(worktreeRoot)} ${buildId}`;
    return env;
}

function formatStatus(
    worktreeRoot: string,
    sourceHome: string,
    destinationHome: string,
): string {
    const meta = existsSync(destinationHome)
        ? readInstanceMeta(destinationHome)
        : undefined;
    const pid = readLockPid(join(destinationHome, "runtime", "host.json"));
    const live = pid !== undefined && processIsAlive(pid);
    return [
        `Worktree: ${worktreeRoot}`,
        `Build: ${meta?.buildId ?? candidateBuildId(worktreeRoot)}`,
        `Home: ${destinationHome}`,
        `Socket: ${join(destinationHome, "runtime", "host.sock")}`,
        `Host PID: ${live ? String(pid) : "not running"}`,
        `Snapshot: ${meta?.snapshotAt ?? "none"}`,
        `Daily home: ${sourceHome}`,
        "",
    ].join("\n");
}

function dailyHostAppearsRunning(sourceHome: string): boolean {
    const pid = readLockPid(join(sourceHome, "runtime", "host.json"));
    return pid !== undefined && processIsAlive(pid);
}

function readLockPid(lockPath: string): number | undefined {
    if (!existsSync(lockPath)) return undefined;
    try {
        const value = JSON.parse(readFileSync(lockPath, "utf8")) as {
            pid?: unknown;
        };
        return typeof value.pid === "number" ? value.pid : undefined;
    } catch {
        return undefined;
    }
}

async function stopCandidate(
    destinationHome: string,
    stderr: { write(text: string): unknown },
): Promise<number> {
    const lockPath = join(destinationHome, "runtime", "host.json");
    if (!existsSync(lockPath)) {
        stderr.write("No development instance host is running.\n");
        return 0;
    }
    const outcome = await forceStopResidentHost({ lockPath });
    if (outcome === undefined) {
        stderr.write("No development instance host is running.\n");
        return 0;
    }
    if (outcome.endedBy === "survived") {
        stderr.write(`Development host PID ${outcome.pid} did not stop.\n`);
        return 1;
    }
    return 0;
}

async function confirmDiscard(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await rl.question(`${question} [y/N] `);
        return answer.trim().toLowerCase() === "y";
    } finally {
        rl.close();
    }
}

async function spawnWorktreeTui(
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
): Promise<number> {
    const child = Bun.spawn(
        [process.execPath, CLI_ENTRYPOINT, ...args],
        {
            cwd,
            env,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        },
    );
    return await child.exited;
}

if (import.meta.main) {
    try {
        process.exitCode = await runDevTui(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(
            `Could not launch Vera's development TUI: ${
                error instanceof Error ? error.message : String(error)
            }\n`,
        );
        process.exitCode = 1;
    }
}
