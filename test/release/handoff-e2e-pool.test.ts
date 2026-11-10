import { expect } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { inspectHostLockFile } from "../../src/host/lockfile.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { stopRecordedWorkers, stopWorkerProcess, type WorkerStopIdentity } from "../../src/host/pool/stop-worker.ts";
import { readRecordedWorkers } from "../../src/host/pool/worker-records.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { attachReconnectingAgent } from "../../src/host/reconnecting-agent-client.ts";
import { socketFileIdentity } from "../../src/host/socket-file.ts";
import { liveProcessDirectoryIn } from "../../src/live-process.ts";
import { installRelease } from "../../src/release/install.ts";
import { defaultEnsureHost } from "../../src/release/upgrade.ts";
import {
    cloneRelease, createFixture, currentBuild, processAlive, readHostLock, stopHostProcess, waitUntil,
} from "../support/handoff-e2e.ts";

socketAndLoopbackTest("a packed pool upgrades after a turn and leaves no old processes or records", async () => {
    const env = await createFixture({ pool: true });
    const previousHome = process.env.VERA_HOME;
    const previousDev = process.env.VERA_DEV_INSTANCE;
    process.env.VERA_HOME = env.home;
    delete process.env.VERA_DEV_INSTANCE;
    const oldWorkers: WorkerStopIdentity[] = [];
    let client: Awaited<ReturnType<typeof attachReconnectingAgent>> | undefined;
    try {
        await defaultEnsureHost(env.build1Root, { operation: "install", pool: true });
        const oldLock = readHostLock(env.home)!;
        const socket = join(env.home, "runtime", "host.sock");
        const count = Math.max(1, availableParallelism() - 1);
        const records = await readRecordedWorkers(env.home);
        expect(records).toHaveLength(count);
        for (const record of records) {
            expect(record.hostPid).toBe(oldLock.pid);
            oldWorkers.push(record);
        }
        const sockets = [socket, join(env.home, "runtime", "control.sock"),
            ...Array.from({ length: count }, (_, index) => inProcessWorkerSocket(env.home, index))];
        const oldSockets = await Promise.all(sockets.map((path) => socketFileIdentity(path)));
        expect(oldSockets.every((identity) => identity !== undefined)).toBe(true);
        const agent = await createAgentThroughHost(socket, env.workspace, "auto");
        client = await attachReconnectingAgent({ socketPath: () => socket, agentId: agent.id, buildId: env.build1 });
        client.send({ type: "prompt", content: "hello crow" });
        await waitUntil(() => env.stub.requests() > 0, 20_000, "the held turn");

        const build2 = "vera-e2e-pool-update";
        const build2Root = cloneRelease(env.build1Root, env.prefix, build2);
        const manifest = JSON.parse(readFileSync(join(build2Root, "manifest.json"), "utf8"));
        const reports: string[] = [];
        const install = installRelease({
            hotHandOff: true,
            prefix: env.prefix,
            pack: async () => ({ releaseRoot: build2Root, manifest }),
            report: (line) => reports.push(line),
        });
        await Bun.sleep(2_000);
        expect(reports.some((line) => line.startsWith("Waiting for running turns"))).toBe(true);
        expect(currentBuild(env.prefix)).toBe(env.build1);
        env.stub.release();
        expect(await install).toEqual({ kind: "updated", buildId: build2 });
        client.close();
        client = undefined;

        await waitUntil(() => !processAlive(oldLock.pid) && oldWorkers.every((worker) => !processAlive(worker.pid)),
            15_000, "the old host and session processes to exit");
        expect(currentBuild(env.prefix)).toBe(build2);
        const lock = await inspectHostLockFile(join(env.home, "runtime", "host.json"));
        expect(lock.state).toBe("valid");
        if (lock.state !== "valid") throw new Error("New host lock is missing");
        expect(lock.record.build_id).toBe(build2);
        expect(lock.record.pid).not.toBe(oldLock.pid);
        expect(lock.record.worker_count).toBe(count);
        expect((await requestHostIdentity(socket))?.pid).toBe(lock.record.pid);
        for (const [index, path] of sockets.entries()) {
            const identity = await socketFileIdentity(path);
            expect(identity).toBeDefined();
            expect(identity).not.toEqual(oldSockets[index]);
        }
        const nextWorkers = await readRecordedWorkers(env.home);
        expect(nextWorkers).toHaveLength(count);
        for (const worker of nextWorkers) {
            expect(worker.hostPid).toBe(lock.record.pid);
            expect(oldWorkers.some((old) => old.pid === worker.pid)).toBe(false);
            const identity = await requestHostIdentity(inProcessWorkerSocket(env.home, Number(worker.id.slice(1))));
            expect(identity?.pid).toBe(worker.pid);
            expect(identity?.build_id).toBe(build2);
        }
        for (const pid of [oldLock.pid, ...oldWorkers.map((worker) => worker.pid)]) {
            expect(existsSync(join(liveProcessDirectoryIn(env.home), `${pid}.json`))).toBe(false);
        }
    } finally {
        env.stub.release();
        client?.close();
        await stopHostProcess(env.home).catch(() => {});
        await stopRecordedWorkers(env.home).catch(() => {});
        for (const worker of oldWorkers) await stopWorkerProcess(worker).catch(() => {});
        env.cleanup();
        if (previousHome === undefined) delete process.env.VERA_HOME; else process.env.VERA_HOME = previousHome;
        if (previousDev === undefined) delete process.env.VERA_DEV_INSTANCE; else process.env.VERA_DEV_INSTANCE = previousDev;
    }
}, 180_000);
