import { expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { processIsAlive } from "../src/host/process-identity.ts";

const tmuxAvailable = Bun.spawnSync(["tmux", "-V"], {
    stdout: "ignore",
    stderr: "ignore",
}).exitCode === 0;

test.skipIf(!tmuxAvailable)(
    "owned UAT resources die when their controller is SIGKILLed",
    async () => {
        const fixture = await startFixture("death");
        try {
            expect(processIsAlive(fixture.ready.watchdogPid)).toBe(true);
            expect(hasTmuxSession(fixture.socket)).toBe(true);
            expect(processIsAlive(fixture.ready.hostPid)).toBe(true);
            expect(processIsAlive(fixture.sentinel.pid)).toBe(true);

            await Bun.sleep(500);
            expect(processIsAlive(fixture.ready.watchdogPid)).toBe(true);
            expect(hasTmuxSession(fixture.socket)).toBe(true);

            fixture.controller.kill("SIGKILL");
            await fixture.controller.exited;

            await waitFor(
                () => !hasTmuxSession(fixture.socket),
                "tmux server to exit",
            );
            await waitFor(
                () => !processIsAlive(fixture.ready.hostPid),
                "temporary host to exit",
            );
            await waitFor(
                () => !processIsAlive(fixture.ready.watchdogPid),
                "owner watchdog to exit",
            );
            expect(processIsAlive(fixture.sentinel.pid)).toBe(true);
        } finally {
            cleanFixture(fixture);
        }
    },
    15_000,
);

test.skipIf(!tmuxAvailable)(
    "lease expiry reaps a host published after its controller wedges",
    async () => {
        const fixture = await startFixture("wedge");
        try {
            expect(processIsAlive(fixture.controller.pid)).toBe(true);
            expect(processIsAlive(fixture.ready.hostPid)).toBe(true);
            expect(existsSync(fixture.ready.hostLockPath)).toBe(false);

            // The controller remains alive but Atomics.wait prevents its
            // heartbeat timer from renewing the 200ms lease.
            await waitFor(
                () => !hasTmuxSession(fixture.socket),
                "lease expiry to close the tmux server",
            );
            await waitFor(
                () => !processIsAlive(fixture.controller.pid),
                "expired controller to exit",
            );

            // Publish only after cleanup has begun. The pre-registered lock
            // path lets a later cleanup attempt discover and stop the host.
            writeFileSync(fixture.ready.publishHostPath, "publish\n");
            await waitFor(
                () => existsSync(fixture.ready.hostLockPath),
                "temporary host to publish its lock",
            );
            await waitFor(
                () => !processIsAlive(fixture.ready.hostPid),
                "late-published temporary host to exit",
            );
            await waitFor(
                () => !processIsAlive(fixture.ready.watchdogPid),
                "expired owner watchdog to exit",
            );
            expect(processIsAlive(fixture.sentinel.pid)).toBe(true);
        } finally {
            cleanFixture(fixture);
        }
    },
    15_000,
);

type ControllerMode = "death" | "wedge";

interface ReadyRecord {
    readonly hostPid: number;
    readonly watchdogPid: number;
    readonly hostLockPath: string;
    readonly publishHostPath: string;
}

interface OwnerFixture {
    readonly root: string;
    readonly socket: string;
    readonly sentinel: Bun.Subprocess<"ignore", "ignore", "ignore">;
    readonly controller: Bun.Subprocess<"ignore", "ignore", "pipe">;
    readonly ready: ReadyRecord;
}

async function startFixture(mode: ControllerMode): Promise<OwnerFixture> {
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
        mode,
        socket,
        readyPath,
        String(sentinel.pid),
    ], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    try {
        const ready = await waitForReady(readyPath, controller);
        return { root, socket, sentinel, controller, ready };
    } catch (error) {
        cleanFixture({
            root,
            socket,
            sentinel,
            controller,
            ready: {
                hostPid: -1,
                watchdogPid: -1,
                hostLockPath: join(root, "host.json"),
                publishHostPath: join(root, "publish-host"),
            },
        });
        throw error;
    }
}

function cleanFixture(fixture: OwnerFixture): void {
    if (processIsAlive(fixture.controller.pid)) {
        fixture.controller.kill("SIGKILL");
    }
    if (processIsAlive(fixture.sentinel.pid)) fixture.sentinel.kill("SIGKILL");
    if (
        fixture.ready.hostPid > 0
        && processIsAlive(fixture.ready.hostPid)
    ) {
        process.kill(fixture.ready.hostPid, "SIGKILL");
    }
    if (
        fixture.ready.watchdogPid > 0
        && processIsAlive(fixture.ready.watchdogPid)
    ) {
        process.kill(fixture.ready.watchdogPid, "SIGKILL");
    }
    Bun.spawnSync(["tmux", "-L", fixture.socket, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
    });
    rmSync(fixture.root, { recursive: true, force: true });
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
                Number.isInteger(value.hostPid)
                && value.hostPid > 0
                && Number.isInteger(value.watchdogPid)
                && value.watchdogPid > 0
                && typeof value.hostLockPath === "string"
                && typeof value.publishHostPath === "string"
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
