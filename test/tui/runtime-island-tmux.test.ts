import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
    diagnoseVeraProcesses,
} from "../../clients/process-doctor.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import {
    ownTmuxServer,
    ownVeraHostLock,
} from "../support/uat-process-owner.ts";
import { killTmuxServer } from "../support/kill-tmux-server.ts";

/**
 * Two real CLI TUIs, two runtime islands, one machine. Starting the second
 * must not SIGKILL the first, and each doctor must refuse the other island.
 */
const tmuxAvailable = canRunTmux();

test.skipIf(!tmuxAvailable)(
    "starting a worktree TUI does not kill a daily-like host, and doctor stays in its island",
    async () => {
        const socket = `vera-island-${process.pid}-${randomUUID()}`;
        const home = mkdtempSync(join(tmpdir(), "vera-island-home-"));
        const worktreeRuntime = mkdtempSync(join(tmpdir(), "vera-island-tree-"));
        const dailyRuntime = join(home, ".vera", "runtime");
        mkdirSync(join(home, ".vera"), { recursive: true });
        writeFileSync(
            join(home, ".vera", "config.json"),
            `${JSON.stringify({
                schema_version: 1,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto",
            })}\n`,
        );
        ownVeraHostLock(join(dailyRuntime, "host.json"));
        ownVeraHostLock(join(worktreeRuntime, "host.json"));

        let dailyPane = "";
        let treePane = "";
        try {
            startCliTui(socket, "daily", home, {
                VERA_PROFILE: "dev",
            });
            dailyPane = await waitForVisiblePane(
                socket,
                "daily",
                "New conversation",
            );
            const dailyHostPid = await waitForLiveHostPid(dailyRuntime);
            expect(processIsAlive(dailyHostPid)).toBe(true);

            startCliTui(socket, "tree", home, {
                VERA_PROFILE: "dev",
                VERA_RUNTIME_DIR: worktreeRuntime,
            });
            treePane = await waitForVisiblePane(
                socket,
                "tree",
                "New conversation",
            );
            const treeHostPid = await waitForLiveHostPid(worktreeRuntime);
            expect(treeHostPid).not.toBe(dailyHostPid);
            expect(processIsAlive(dailyHostPid)).toBe(true);
            expect(processIsAlive(treeHostPid)).toBe(true);

            dailyPane = captureVisiblePane(socket, "daily");
            expect(dailyPane).toContain("New conversation");
            expect(dailyPane).not.toContain("disconnected");
            expect(dailyPane).not.toContain("The operation timed out");
            expect(dailyPane).not.toContain("Disconnected from the host");
            expect(treePane).not.toContain("disconnected");

            const dailyDoctor = await diagnoseVeraProcesses({
                runtimeIsland: dailyRuntime,
                sampleIntervalMs: 0,
                doctorPid: process.pid,
            });
            const treeDoctor = await diagnoseVeraProcesses({
                runtimeIsland: worktreeRuntime,
                sampleIntervalMs: 0,
                doctorPid: process.pid,
            });
            expect(dailyDoctor.processes.some((process) =>
                process.pid === treeHostPid
            )).toBe(false);
            expect(treeDoctor.processes.some((process) =>
                process.pid === dailyHostPid
            )).toBe(false);
            expect(dailyDoctor.processes.some((process) =>
                process.stray && process.pid === dailyHostPid
            )).toBe(false);
            expect(treeDoctor.processes.some((process) =>
                process.stray && process.pid === treeHostPid
            )).toBe(false);

            const yes = Bun.spawnSync([
                process.execPath,
                "run",
                "clients/cli/main.ts",
                "doctor",
                "--yes",
            ], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HOME: home,
                    VERA_HOME: join(home, ".vera"),
                    VERA_PROFILE: "dev",
                    VERA_RUNTIME_DIR: worktreeRuntime,
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(yes.exitCode).toBeLessThan(2);
            expect(processIsAlive(dailyHostPid)).toBe(true);
            expect(processIsAlive(treeHostPid)).toBe(true);
            dailyPane = captureVisiblePane(socket, "daily");
            expect(dailyPane).not.toContain("The operation timed out");
            expect(dailyPane).not.toContain("Disconnected from the host");
        } catch (error) {
            throw new Error(
                `${errorMessage(error)}\n\nDaily pane:\n${dailyPane}\n\nTree pane:\n${treePane}`,
            );
        } finally {
            killTmuxServer(socket);
            await stopHost(dailyRuntime);
            await stopHost(worktreeRuntime);
            rmSync(home, { recursive: true, force: true });
            rmSync(worktreeRuntime, { recursive: true, force: true });
        }
    },
    45_000,
);

function startCliTui(
    socket: string,
    session: string,
    home: string,
    extraEnv: Readonly<Record<string, string>>,
): void {
    const exported = Object.entries(extraEnv)
        .map(([name, value]) => `${name}=${shellQuote(value)} `)
        .join("");
    runTmux(socket, [
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "100",
        "-y",
        "30",
        `cd ${shellQuote(process.cwd())} && HOME=${shellQuote(home)} VERA_HOME=${
            shellQuote(join(home, ".vera"))
        } ${exported}exec ${shellQuote(process.execPath)} run clients/cli/main.ts`,
    ]);
}

async function waitForLiveHostPid(runtime: string): Promise<number> {
    const lockPath = join(runtime, "host.json");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (existsSync(lockPath)) {
            try {
                const record = JSON.parse(readFileSync(lockPath, "utf8")) as {
                    readonly pid?: unknown;
                };
                if (Number.isInteger(record.pid) && (record.pid as number) > 0) {
                    const pid = record.pid as number;
                    if (processIsAlive(pid)) return pid;
                }
            } catch {
                // Lock is still being published.
            }
        }
        await Bun.sleep(50);
    }
    throw new Error(`Timed out waiting for host lock at ${lockPath}`);
}

async function waitForVisiblePane(
    socket: string,
    session: string,
    expected: string,
): Promise<string> {
    const deadline = Date.now() + 20_000;
    let pane = "";
    while (Date.now() < deadline) {
        try {
            pane = captureVisiblePane(socket, session);
        } catch {
            pane = "";
        }
        if (pane.includes(expected)) return pane;
        await Bun.sleep(50);
    }
    throw new Error(
        `Timed out waiting for ${JSON.stringify(expected)}\n\nLast pane:\n${pane}`,
    );
}

function captureVisiblePane(socket: string, session: string): string {
    return runTmux(socket, ["capture-pane", "-p", "-t", session]);
}

function runTmux(socket: string, args: readonly string[]): string {
    if (args.includes("new-session")) ownTmuxServer(socket);
    const result = Bun.spawnSync(["tmux", "-L", socket, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        throw new Error(`tmux ${args[0]} failed: ${stderr || stdout.trim()}`);
    }
    return stdout;
}

function canRunTmux(): boolean {
    const socket = `vera-probe-${process.pid}-${randomUUID()}`;
    const result = Bun.spawnSync([
        "tmux",
        "-L",
        socket,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "probe",
        "sleep 1",
    ], {
        stdout: "ignore",
        stderr: "ignore",
    });
    const session = Bun.spawnSync([
        "tmux",
        "-L",
        socket,
        "has-session",
        "-t",
        "probe",
    ], {
        stdout: "ignore",
        stderr: "ignore",
    });
    killTmuxServer(socket);
    return result.exitCode === 0 && session.exitCode === 0;
}

async function stopHost(runtime: string): Promise<void> {
    const lockPath = join(runtime, "host.json");
    if (!existsSync(lockPath)) return;
    let record: { readonly pid?: unknown };
    try {
        record = JSON.parse(readFileSync(lockPath, "utf8")) as {
            readonly pid?: unknown;
        };
    } catch {
        return;
    }
    if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return;
    const pid = record.pid as number;
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        return;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!processIsAlive(pid)) return;
        await Bun.sleep(10);
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // Already gone.
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
