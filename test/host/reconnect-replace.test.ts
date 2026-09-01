import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findOrStartResidentHost } from "../../clients/host/launch.ts";
import { attachAgent } from "../../src/host/attached-client.ts";
import type { HostLockRecord } from "../../src/host/lockfile.ts";
import { seedTestRelease } from "../support/seed-test-release.ts";

interface DetachedHostResult {
    readonly starterPid: number;
    readonly host: HostLockRecord;
    readonly agentId: string;
}

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "manual reconnect force-stops a wedged host and keeps the session id",
    async () => {
        const started = await startDetachedHost();
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = started.veraHome;
        let replacementPid: number | undefined;
        try {
            process.kill(started.host.pid, "SIGSTOP");
            const replacement = await findOrStartResidentHost({
                confirmBusyUpgrade: () => true,
                startupTimeoutMs: 15_000,
            });
            replacementPid = replacement.pid;
            expect(replacement.pid).not.toBe(started.host.pid);
            expect(replacement.started_at).not.toBe(started.host.started_at);
            const client = await attachAgent({
                socketPath: replacement.socket_path,
                agentId: started.agentId,
            });
            expect((await client.receive()).type).toBe("history");
            await client.detach();
        } finally {
            restoreHome(previousHome);
            await stopHost(started.host.pid);
            if (replacementPid !== undefined) await stopHost(replacementPid);
            await rm(started.home, { recursive: true, force: true });
        }
    },
    20_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "replaceExisting replaces an idle answering host and keeps the session id",
    async () => {
        const started = await startDetachedHost();
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = started.veraHome;
        let replacementPid: number | undefined;
        try {
            const replacement = await findOrStartResidentHost({
                confirmBusyUpgrade: () => true,
                replaceExisting: true,
                startupTimeoutMs: 15_000,
            });
            replacementPid = replacement.pid;
            expect(replacement.pid).not.toBe(started.host.pid);
            expect(replacement.started_at).not.toBe(started.host.started_at);
            const client = await attachAgent({
                socketPath: replacement.socket_path,
                agentId: started.agentId,
            });
            expect((await client.receive()).type).toBe("history");
            await client.detach();
        } finally {
            restoreHome(previousHome);
            await stopHost(started.host.pid);
            if (replacementPid !== undefined) await stopHost(replacementPid);
            await rm(started.home, { recursive: true, force: true });
        }
    },
    20_000,
);

async function startDetachedHost(): Promise<{
    readonly home: string;
    readonly veraHome: string;
    readonly host: HostLockRecord;
    readonly agentId: string;
}> {
    const home = await mkdtemp(join(tmpdir(), "vera-reconnect-host-"));
    const veraHome = join(home, ".vera");
    const profile = join(veraHome);
    await mkdir(profile, { recursive: true });
    seedTestRelease(home);
    await writeFile(join(profile, "config.json"), `${JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
    })}\n`);
    const child = Bun.spawn([
        process.execPath,
        "test/support/detached-host-child.ts",
    ], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            HOME: home,
            VERA_HOME: veraHome,
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
    expect(processIsAlive(result.host.pid)).toBe(true);
    return {
        home,
        veraHome,
        host: result.host,
        agentId: result.agentId,
    };
}

function restoreHome(previousHome: string | undefined): void {
    if (previousHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousHome;
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function stopHost(pid: number): Promise<void> {
    if (!processIsAlive(pid)) return;
    try {
        process.kill(pid, "SIGCONT");
    } catch {
        // Already gone or not stopped.
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        return;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!processIsAlive(pid)) return;
        await Bun.sleep(10);
    }
}
