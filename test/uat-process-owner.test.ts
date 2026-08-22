import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { processIsAlive } from "../src/host/process-identity.ts";

const tmuxAvailable = Bun.spawnSync(["tmux", "-V"], {
    stdout: "ignore",
    stderr: "ignore",
}).exitCode === 0;

test.skipIf(!tmuxAvailable)(
    "owned UAT processes die when their controller is SIGKILLed",
    async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-uat-owner-test-"));
        const readyPath = join(root, "ready.json");
        const socket = `vera-owner-test-${process.pid}-${randomUUID()}`;
        const sentinel = Bun.spawn([
            process.execPath,
            "-e",
            "await Bun.sleep(300000)",
        ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        const controller = Bun.spawn([
            process.execPath,
            "run",
            join(import.meta.dir, "support", "uat-process-owner-controller.ts"),
            socket,
            readyPath,
            String(sentinel.pid),
        ], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
        let ownedPid: number | undefined;
        let hostPid: number | undefined;
        let watchdogPid: number | undefined;

        try {
            const ready = await waitForReady(readyPath, controller);
            ownedPid = ready.ownedPid;
            hostPid = ready.hostPid;
            watchdogPid = ready.watchdogPid;
            expect(controller.exitCode).toBeNull();
            expect(processIsAlive(watchdogPid)).toBe(true);
            expect(hasTmuxSession(socket)).toBe(true);
            expect(processIsAlive(ownedPid)).toBe(true);
            expect(processIsAlive(hostPid)).toBe(true);
            expect(processIsAlive(sentinel.pid)).toBe(true);

            controller.kill("SIGKILL");
            await controller.exited;

            await waitFor(() => !hasTmuxSession(socket), "tmux server to exit");
            await waitFor(() => !processIsAlive(ownedPid!), "owned child to exit");
            await waitFor(() => !processIsAlive(hostPid!), "temporary host to exit");
            await waitFor(
                () => !processIsAlive(watchdogPid!),
                "owner watchdog to exit",
            );
            expect(processIsAlive(sentinel.pid)).toBe(true);
        } finally {
            if (controller.exitCode === null) controller.kill("SIGKILL");
            if (processIsAlive(sentinel.pid)) sentinel.kill("SIGKILL");
            if (ownedPid !== undefined && processIsAlive(ownedPid)) {
                process.kill(ownedPid, "SIGKILL");
            }
            if (hostPid !== undefined && processIsAlive(hostPid)) {
                process.kill(hostPid, "SIGKILL");
            }
            if (watchdogPid !== undefined && processIsAlive(watchdogPid)) {
                process.kill(watchdogPid, "SIGKILL");
            }
            Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            rmSync(root, { recursive: true, force: true });
        }
    },
    15_000,
);

interface ReadyRecord {
    readonly ownedPid: number;
    readonly hostPid: number;
    readonly watchdogPid: number;
}

async function waitForReady(
    path: string,
    controller: Bun.Subprocess<"ignore", "ignore", "pipe">,
): Promise<ReadyRecord> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            const value = JSON.parse(readFileSync(path, "utf8")) as ReadyRecord;
            if (
                Number.isInteger(value.ownedPid)
                && Number.isInteger(value.hostPid)
                && Number.isInteger(value.watchdogPid)
            ) return value;
        } catch {
            // The controller has not published its complete ready record yet.
        }
        if (controller.exitCode !== null) {
            throw new Error(
                `UAT owner controller exited ${controller.exitCode}: ${
                    await new Response(controller.stderr).text()
                }`,
            );
        }
        await Bun.sleep(25);
    }
    throw new Error("Timed out waiting for UAT owner controller");
}

async function waitFor(
    predicate: () => boolean,
    description: string,
): Promise<void> {
    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(25);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

function hasTmuxSession(socket: string): boolean {
    return Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", "owned"], {
        stdout: "ignore",
        stderr: "ignore",
    }).exitCode === 0;
}
