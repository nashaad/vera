import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { inspectHostLockFile } from "../../src/host/lockfile.ts";
import { stopWorkerProcess, type WorkerStopIdentity } from "../../src/host/pool/stop-worker.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";

function workingDirectoryOf(pid: number): string | undefined {
    const listed = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    return listed.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
}

socketTest("@core a host started from a folder that is later deleted runs in its home", async () => {
    await mkdir("/tmp/vera-dev", { recursive: true });
    const root = await mkdtemp(join(await realpath("/tmp/vera-dev"), "start-folder-"));
    const home = join(root, "h");
    const userHome = join(root, "u");
    const launchFolder = join(root, "worktree");
    await mkdir(home);
    await mkdir(userHome);
    await mkdir(launchFolder);
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
        host: { workers: 1 },
    }));
    const child = Bun.spawn([process.execPath, resolve("clients/host/main.ts")], {
        cwd: launchFolder,
        env: { ...process.env, HOME: userHome, VERA_HOME: home, VERA_DEV_INSTANCE: "hoststart dev" },
        stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    let worker: WorkerStopIdentity | undefined;
    try {
        const deadline = Date.now() + 30_000;
        while (true) {
            if (child.exitCode !== null) throw new Error(`Host exited during startup: ${await stderr}`);
            const lock = await inspectHostLockFile(join(home, "runtime", "host.json"));
            const identity = await requestHostIdentity(join(home, "runtime", "host.sock"));
            if (lock.state === "valid" && lock.record.pid === child.pid && identity?.pid === child.pid) break;
            if (Date.now() >= deadline) throw new Error("Host did not publish its lock");
            await Bun.sleep(25);
        }
        worker = JSON.parse(await readFile(join(home, "runtime", "workers", "w0.json"), "utf8")) as WorkerStopIdentity;
        await rm(launchFolder, { recursive: true, force: true });

        expect(workingDirectoryOf(child.pid)).toBe(home);
        expect(workingDirectoryOf(worker.pid)).toBe(home);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await Promise.race([child.exited, Bun.sleep(5_000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        if (worker !== undefined) await stopWorkerProcess(worker);
        await stderr;
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
