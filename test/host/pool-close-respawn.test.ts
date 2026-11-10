import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { readRecordedWorkers } from "../../src/host/pool/worker-records.ts";
import { stopWorkerProcess } from "../../src/host/pool/stop-worker.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";

// A worker that leaves while the host server closes must not be replaced by the closing host.
socketTest("a closing pool host does not replace a worker that leaves during close", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "close-respawn-"));
    const webRoot = join(home, "web");
    await mkdir(webRoot);
    await Promise.all(["index.html", "main.js", "styles.css"].map((name) => writeFile(join(webRoot, name), "")));
    const config = {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:9/v1", credential: "none" } },
    } as const;
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const options = { home, config, webRoot, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true };
    const lockPath = join(home, "runtime", "host.json");
    const workers: Array<{ pid: number; started_at: string }> = [];
    let host: ResidentHost | undefined;
    let intercepted = false;
    const replaced: Array<{ pid: number; started_at: string }> = [];
    try {
        host = await startResidentHost(options);
        const worker = await requestHostIdentity(inProcessWorkerSocket(home));
        if (worker === undefined) throw new Error("Session process did not start");
        workers.push(worker);
        const server = host.server as { close(): Promise<void> };
        const closeServer = server.close.bind(server);
        server.close = async () => {
            if (intercepted) return closeServer();
            intercepted = true;
            process.kill(worker.pid, "SIGTERM");
            const deadline = Date.now() + 5_000;
            while (processIsAlive(worker.pid) && Date.now() < deadline) await Bun.sleep(20);
            await Bun.sleep(1_500);
            for (const record of await readRecordedWorkers(home)) {
                if (record.pid !== worker.pid) replaced.push(record);
            }
            await closeServer();
        };
        await host.close();
        expect(intercepted).toBe(true);
        expect(replaced).toEqual([]);
        expect(await readRecordedWorkers(home)).toEqual([]);
        expect(existsSync(lockPath)).toBe(false);
    } finally {
        await host?.close().catch(() => {});
        workers.push(...replaced);
        for (const record of await readRecordedWorkers(home).catch(() => [])) workers.push(record);
        for (const worker of workers) {
            if (processIsAlive(worker.pid)) await stopWorkerProcess(worker).catch(() => {});
        }
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);
