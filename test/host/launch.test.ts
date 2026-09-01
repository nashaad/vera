import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    residentHostEntrypoint,
    residentHostSpawnSpec,
    worktreeRuntimeNotice,
} from "../../clients/host/launch.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { seedTestRelease } from "../support/seed-test-release.ts";

interface DetachedHostResult {
    readonly starterPid: number;
    readonly host: HostLockRecord;
    readonly agentId: string;
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the first client starts a detached host that survives and accepts attach",
    async () => {
        const home = await mkdtemp(join(tmpdir(), "vera-detached-host-"));
        const veraDirectory = join(home, ".vera");
        let hostPid: number | undefined;
        await mkdir(veraDirectory, { recursive: true });
        seedTestRelease(home);
        await writeFile(join(veraDirectory, "config.json"), `${JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        })}\n`);

        try {
            const child = Bun.spawn([
                process.execPath,
                "test/support/detached-host-child.ts",
            ], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HOME: home,
                    VERA_HOME: join(home, ".vera"),
                    OPENROUTER_API_KEY: "test-only-key",
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [exitCode, output, errorOutput] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            expect(exitCode, errorOutput).toBe(0);
            const result = JSON.parse(output) as DetachedHostResult;
            hostPid = result.host.pid;
            expect(result.host.pid).not.toBe(result.starterPid);
            expect(processIsAlive(result.host.pid)).toBe(true);

            const client = await attachAgent({
                socketPath: result.host.socket_path,
                agentId: result.agentId,
            });
            expect((await client.receive()).type).toBe("history");
            await client.detach();

            const lock = JSON.parse(
                await readFile(join(veraDirectory, "runtime", "host.json"), "utf8"),
            ) as HostLockRecord;
            expect(lock).toEqual(result.host);
            expect(typeof lock.build_id).toBe("string");
            expect(lock.build_id?.length).toBeGreaterThan(0);
        } finally {
            if (hostPid !== undefined && processIsAlive(hostPid)) {
                process.kill(hostPid, "SIGTERM");
                await waitForProcessExit(hostPid);
            }
            await rm(home, { recursive: true, force: true });
        }
    },
    10_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "ten simultaneous first clients from ten directories share one host",
    async () => {
        const home = await mkdtemp(join(tmpdir(), "vera-ten-host-"));
        const veraDirectory = join(home, ".vera");
        let hostPid: number | undefined;
        await mkdir(veraDirectory, { recursive: true });
        seedTestRelease(home);
        await writeFile(join(veraDirectory, "config.json"), `${JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        })}\n`);
        const expectedSocket = join(veraDirectory, "runtime", "host.sock");
        const projects = await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
                mkdtemp(join(home, `proj-${index}-`))),
        );

        try {
            const script = join(process.cwd(), "test/support/detached-host-child.ts");
            const children = await Promise.all(projects.map(async (cwd) => {
                const child = Bun.spawn([
                    process.execPath,
                    script,
                ], {
                    cwd,
                    env: {
                        ...process.env,
                        HOME: home,
                        VERA_HOME: veraDirectory,
                        OPENROUTER_API_KEY: "test-only-key",
                    },
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [exitCode, output, errorOutput] = await Promise.all([
                    child.exited,
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                ]);
                expect(exitCode, `${cwd}: ${errorOutput}`).toBe(0);
                return JSON.parse(output) as DetachedHostResult;
            }));
            const pids = new Set(children.map((result) => result.host.pid));
            const sockets = new Set(children.map((result) => result.host.socket_path));
            expect(pids.size).toBe(1);
            expect(sockets).toEqual(new Set([expectedSocket]));
            hostPid = children[0]!.host.pid;
            expect(processIsAlive(hostPid)).toBe(true);
        } finally {
            if (hostPid !== undefined && processIsAlive(hostPid)) {
                process.kill(hostPid, "SIGTERM");
                await waitForProcessExit(hostPid);
            }
            await rm(home, { recursive: true, force: true });
        }
    },
    30_000,
);

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!processIsAlive(pid)) {
            return;
        }
        await Bun.sleep(10);
    }
    throw new Error(`Detached host ${pid} did not exit`);
}

/** A checkout whose `.git` is a file, the way a linked worktree records it. */
async function linkedWorktree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vera-linked-worktree-"));
    await writeFile(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    await mkdir(join(root, "clients"), { recursive: true });
    return root;
}

test("a worktree started without its own runtime is warned about", async () => {
    const root = await linkedWorktree();
    try {
        expect(worktreeRuntimeNotice(join(root, "clients"), {}))
            .toContain("bun run dev:tui");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a deliberate runtime silences the worktree warning", async () => {
    const root = await linkedWorktree();
    try {
        for (
            const environment of [
                { VERA_HOME: "/tmp/vera-home" },
            ]
        ) {
            expect(worktreeRuntimeNotice(root, environment)).toBeUndefined();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the main checkout is not warned about", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-main-checkout-"));
    try {
        await mkdir(join(root, ".git"), { recursive: true });
        expect(worktreeRuntimeNotice(root, {})).toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a checkout pack without a host wrapper uses bun and the source entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-spec-"));
    try {
        expect(residentHostSpawnSpec(root)).toEqual({
            command: process.execPath,
            args: [residentHostEntrypoint()],
        });
        const packed = join(root, "host");
        await writeFile(packed, "#!/bin/sh\n");
        expect(residentHostSpawnSpec(root)).toEqual({
            command: packed,
            args: [],
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
