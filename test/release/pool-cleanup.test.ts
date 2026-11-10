import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { forceStopPool } from "../../src/host/pool/force-stop-pool.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { releaseManifestPath } from "../../src/release/layout.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { defaultEnsureHost, stopLeftoverPoolWorkers } from "../../src/release/upgrade.ts";
import { readPoolWorkerPids } from "../support/pool-worker-pids.ts";

test("an installer stops a verified leftover session process before starting a build", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs9-upgrade-"));
    const workers = join(home, "runtime", "workers");
    const ready = join(home, "ready");
    await mkdir(workers, { recursive: true });
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, ["-e", `
        const fs = require("node:fs");
        process.on("SIGTERM", () => {});
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        setInterval(() => {}, 1000);
    `], { stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
        if (child.pid === undefined) throw new Error("Test process did not start");
        const until = Date.now() + 5_000;
        while (!existsSync(ready)) {
            if (Date.now() >= until) throw new Error("Test process did not become ready");
            await Bun.sleep(10);
        }
        await writeFile(join(workers, "w0.json"), JSON.stringify({
            id: "w0", pid: child.pid, started_at: startedAt, build_id: "old-build",
        }));
        await stopLeftoverPoolWorkers(home);
        await exited;
        expect(processIsAlive(child.pid)).toBe(false);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await rm(home, { recursive: true, force: true });
    }
}, 15_000);

socketTest("a development pool starts only after a verified old-build session process exits", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs9-upgrade-dev-"));
    const workers = join(home, "runtime", "workers");
    const releaseRoot = join(home, "release");
    const web = join(home, "web");
    const ready = join(home, "old-ready");
    await Promise.all([mkdir(workers, { recursive: true }), mkdir(releaseRoot), mkdir(web)]);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(web, name), "")));
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
    }));
    const previousHome = process.env.VERA_HOME;
    const previousMarker = process.env.VERA_DEV_INSTANCE;
    process.env.VERA_HOME = home;
    process.env.VERA_DEV_INSTANCE = "hsplit9 dev";
    const startedAt = new Date().toISOString();
    const old = spawn(process.execPath, ["-e", `
        const fs = require("node:fs");
        process.on("SIGTERM", () => {});
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        setInterval(() => {}, 1000);
    `], { stdio: "ignore" });
    const oldExited = new Promise<void>((resolve) => old.once("close", () => resolve()));
    try {
        if (old.pid === undefined) throw new Error("Test process did not start");
        const deadline = Date.now() + 5_000;
        while (!existsSync(ready)) {
            if (Date.now() >= deadline) throw new Error("Test process did not become ready");
            await Bun.sleep(10);
        }
        await writeFile(join(workers, "w0.json"), JSON.stringify({
            id: "w0", pid: old.pid, started_at: startedAt, build_id: "old-build",
        }));
        const manifest = JSON.parse(await readFile(releaseManifestPath(), "utf8"));
        manifest.build_id = thisProcessBuildId();
        await writeFile(join(releaseRoot, "manifest.json"), JSON.stringify(manifest));
        const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
        await writeFile(join(releaseRoot, "host"), [
            "#!/bin/sh", '[ "$1" = "--pool" ] || exit 2',
            `exec ${quote(process.execPath)} ${quote(join(process.cwd(), "test", "host", "fixtures", "pool-stop-host.ts"))} "$@"`,
            "",
        ].join("\n"), { mode: 0o755 });
        let observedAtLaunch = true;
        await defaultEnsureHost(releaseRoot, {
            pool: true, publishTimeoutMs: 15_000,
            recorder: {
                launched: async () => { observedAtLaunch = processIsAlive(old.pid!); },
                resolved: async () => {},
            },
        });
        expect(observedAtLaunch).toBe(false);
        await oldExited;
        const socket = join(home, "runtime", "host.sock");
        const readyBy = Date.now() + 10_000;
        while ((await requestHostIdentity(socket))?.workers_ready !== 3) {
            if (Date.now() >= readyBy) throw new Error("Development pool did not become ready");
            await Bun.sleep(25);
        }
        const identity = await requestHostIdentity(socket);
        expect(identity).toMatchObject({ role: "host", worker_count: 3 });
        const next = await readPoolWorkerPids(home);
        expect(next).toHaveLength(3);
        expect(next).not.toContain(old.pid);
    } finally {
        await forceStopPool(home);
        if (old.exitCode === null && old.signalCode === null) old.kill("SIGKILL");
        await oldExited;
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        if (previousMarker === undefined) delete process.env.VERA_DEV_INSTANCE;
        else process.env.VERA_DEV_INSTANCE = previousMarker;
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);
