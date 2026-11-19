import { expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { requestHostIdentity } from "../../src/host/protocol.ts";
import { seedTestRelease } from "../support/seed-test-release.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

async function waitFor(check: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = performance.now() + 20_000;
    while (!await check()) {
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await Bun.sleep(25);
    }
}

function isTestHost(pid: number, home: string): boolean {
    const result = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
    return result.stdout.includes(`VERA_HOME=${home}`) && result.stdout.includes("vera-host");
}

socketAndLoopbackTest("boot reattaches to a real host whose lock was deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-hlb-"));
    const home = join(root, "h");
    const lockPath = join(home, "runtime", "host.json");
    const socketPath = join(home, "runtime", "host.sock");
    await mkdir(home);
    seedTestRelease(root);
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
        host: { workers: 0 },
    }));
    const env = { ...process.env, HOME: root, VERA_HOME: home, VERA_DEV_INSTANCE: "hostlock dev", TMPDIR: root };
    const host = spawn(process.execPath, [resolve("clients/host/main.ts"), "--single-process"], {
        cwd: process.cwd(), env, argv0: "vera-host", stdio: "ignore",
    });
    const hostExited = new Promise<void>((resolveExit) => host.once("exit", () => resolveExit()));
    let boot: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
        expect(host.pid).toBeDefined();
        await waitFor(async () => {
            try {
                const record = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
                return record.pid === host.pid && (await requestHostIdentity(socketPath))?.pid === host.pid;
            } catch {
                return false;
            }
        }, "the test host to publish");
        const original = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; started_at: string };
        await unlink(lockPath);
        boot = Bun.spawn([process.execPath, "clients/cli/main.ts", "boot", "--json"], {
            cwd: process.cwd(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [code, output, errors] = await Promise.all([
            boot.exited, new Response(boot.stdout).text(), new Response(boot.stderr).text(),
        ]);
        expect(code, `${output}\n${errors}`).toBe(0);
        const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines.find((line) => line.type === "question")).toBeUndefined();
        expect(lines.at(-1)).toMatchObject({ type: "ready", pid: host.pid });
        expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject(original);
        expect((await requestHostIdentity(socketPath))?.pid).toBe(host.pid);
        const log = await readFile(join(home, "runtime", "logs", "host.jsonl"), "utf8");
        expect(log).toContain('"type":"host_lock_restored"');
        expect(log).not.toContain('"type":"host_stopping"');
        boot = undefined;
    } finally {
        if (boot !== undefined && boot.exitCode === null) {
            boot.kill("SIGTERM");
            await boot.exited;
        }
        if (host.pid !== undefined && host.exitCode === null && host.signalCode === null && isTestHost(host.pid, home)) {
            host.kill("SIGTERM");
            await Promise.race([hostExited, Bun.sleep(5_000)]);
            if (host.exitCode === null && host.signalCode === null && isTestHost(host.pid, home)) host.kill("SIGKILL");
        }
        await hostExited;
        await Bun.sleep(1_100);
        await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        await rm(root, { recursive: true, force: true });
    }
}, 40_000);
