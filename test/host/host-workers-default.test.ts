import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectHostLockFile } from "../../src/host/lockfile.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { stopWorkerProcess, type WorkerStopIdentity } from "../../src/host/pool/stop-worker.ts";
import { checkRecordIdentity, processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { DEFAULT_SESSION_WORKERS } from "../../src/host/runtime.ts";

interface WorkerRecord extends WorkerStopIdentity {
    readonly host_pid: number;
}

async function runHost(workers: number | undefined, args: readonly string[] = []): Promise<void> {
    await mkdir("/tmp/vera-dev", { recursive: true });
    const root = await mkdtemp(join(await realpath("/tmp/vera-dev"), "pd-default-"));
    const home = join(root, "h");
    const userHome = join(root, "u");
    await mkdir(home);
    await mkdir(userHome);
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
        ...(workers === undefined ? {} : { host: { workers } }),
    }));
    const child = Bun.spawn([process.execPath, "clients/host/main.ts", ...args], {
        cwd: process.cwd(), env: { ...process.env, HOME: userHome, VERA_HOME: home, VERA_DEV_INSTANCE: "pooldef dev" },
        stdout: "ignore", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const owned: WorkerStopIdentity[] = [];
    try {
        const expected = workers ?? DEFAULT_SESSION_WORKERS;
        const deadline = Date.now() + 30_000;
        while (true) {
            if (child.exitCode !== null) throw new Error(`Host exited during startup: ${await stderr}`);
            const lock = await inspectHostLockFile(join(home, "runtime", "host.json"));
            const identity = await requestHostIdentity(join(home, "runtime", "host.sock"));
            if (lock.state === "valid" && lock.record.pid === child.pid && identity?.pid === child.pid) {
                expect(lock.record.worker_count).toBe(expected === 0 ? undefined : expected);
                for (let index = 0; index < expected; index += 1) {
                    const record = JSON.parse(await readFile(join(home, "runtime", "workers", `w${index}.json`), "utf8")) as WorkerRecord;
                    expect(record.host_pid).toBe(child.pid);
                    expect(record.pid).not.toBe(child.pid);
                    expect((await requestHostIdentity(inProcessWorkerSocket(home, index)))?.pid).toBe(record.pid);
                    owned.push(record);
                }
                if (expected === 0) expect(await requestHostIdentity(inProcessWorkerSocket(home, 0))).toBeUndefined();
                break;
            }
            if (Date.now() >= deadline) throw new Error("Host did not publish its lock");
            await Bun.sleep(25);
        }
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await Promise.race([child.exited, Bun.sleep(5_000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        const directory = join(home, "runtime", "workers");
        for (const name of await readdir(directory).catch(() => [])) {
            const record = JSON.parse(await readFile(join(directory, name), "utf8")) as WorkerRecord;
            if (record.host_pid === child.pid && !owned.some((worker) => worker.pid === record.pid)) owned.push(record);
        }
        for (const worker of owned) await stopWorkerProcess(worker);
        await stderr;
        await rm(root, { recursive: true, force: true });
    }
}

socketTest("a normal host start uses the default session-process pool", async () => {
    await runHost(undefined);
}, 60_000);

socketTest("a normal host start uses the configured number of session processes", async () => {
    await runHost(2);
}, 60_000);

socketTest("a normal host start with zero workers uses one host process", async () => {
    await runHost(0);
}, 60_000);

socketTest("the compatibility pool flag respects a zero worker setting", async () => {
    await runHost(0, ["--pool"]);
}, 60_000);

for (const nextCount of [0, 1]) socketTest(`a change to ${nextCount} workers applies on the next start after a host crash`, async () => {
    await mkdir("/tmp/vera-dev", { recursive: true });
    const root = await mkdtemp(join(await realpath("/tmp/vera-dev"), "pd-mode-"));
    const home = join(root, "h");
    const userHome = join(root, "u");
    await mkdir(home);
    await mkdir(userHome);
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
        host: { workers: 2 },
    };
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const launch = () => Bun.spawn([process.execPath, "clients/host/main.ts"], {
        cwd: process.cwd(), env: { ...process.env, HOME: userHome, VERA_HOME: home, VERA_DEV_INSTANCE: "pooldef dev" },
        stdout: "ignore", stderr: "pipe",
    });
    const first = launch();
    const firstError = new Response(first.stderr).text();
    let second: ReturnType<typeof launch> | undefined;
    let secondError: Promise<string> | undefined;
    const owned: WorkerStopIdentity[] = [];
    try {
        const waitForLock = async (pid: number) => {
            const deadline = Date.now() + 30_000;
            while (true) {
                const lock = await inspectHostLockFile(join(home, "runtime", "host.json"));
                if (lock.state === "valid" && lock.record.pid === pid) return lock.record;
                if (Date.now() >= deadline) throw new Error("Host did not publish its lock");
                await Bun.sleep(25);
            }
        };
        expect((await waitForLock(first.pid)).worker_count).toBe(2);
        for (let index = 0; index < 2; index += 1) {
            const record = JSON.parse(await readFile(join(home, "runtime", "workers", `w${index}.json`), "utf8")) as WorkerRecord;
            expect(record.host_pid).toBe(first.pid);
            owned.push(record);
        }
        await writeFile(configPath, JSON.stringify({ ...config, host: { workers: nextCount } }));
        expect((await requestHostIdentity(join(home, "runtime", "host.sock")))?.pid).toBe(first.pid);
        expect((await requestHostIdentity(inProcessWorkerSocket(home, 0)))?.pid).toBe(owned[0]!.pid);
        first.kill("SIGKILL");
        await first.exited;
        second = launch();
        secondError = new Response(second.stderr).text();
        expect((await waitForLock(second.pid)).worker_count).toBe(nextCount === 0 ? undefined : nextCount);
        for (const worker of owned) {
            expect(processIsAlive(worker.pid) && checkRecordIdentity(worker) === "match").toBe(false);
        }
        const newWorker = await requestHostIdentity(inProcessWorkerSocket(home, 0));
        if (nextCount === 0) {
            expect(newWorker).toBeUndefined();
        } else {
            expect(newWorker?.pid).toBeDefined();
            expect(owned.some((worker) => worker.pid === newWorker?.pid)).toBe(false);
            const record = JSON.parse(await readFile(join(home, "runtime", "workers", "w0.json"), "utf8")) as WorkerRecord;
            expect(record.host_pid).toBe(second.pid);
            owned.push(record);
        }
    } finally {
        for (const child of [first, second]) {
            if (child === undefined) continue;
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await Promise.race([child.exited, Bun.sleep(5_000)]);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await child.exited;
        }
        for (const worker of owned) await stopWorkerProcess(worker);
        await firstError;
        await secondError;
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
