import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdirSync, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { stopWorkerProcess } from "../../src/host/pool/stop-worker.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { HostSocketHeldError } from "../../src/host/server.ts";

socketTest("a second host cannot start while the pool lock is being removed", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "m9-fence-"));
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
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const unlink = fs.unlink;
    let intercepted = false;
    const delayed = spyOn(fs, "unlink").mockImplementation(async (path) => {
        if (String(path) === lockPath && !intercepted) {
            intercepted = true;
            entered.resolve();
            await release.promise;
        }
        await unlink(path);
    });
    const workers: Array<{ pid: number; started_at: string }> = [];
    let first: ResidentHost | undefined;
    let second: ResidentHost | undefined;
    let closing: Promise<void> | undefined;
    try {
        first = await startResidentHost(options);
        const worker = await requestHostIdentity(inProcessWorkerSocket(home));
        if (worker === undefined) throw new Error("Session process did not start");
        workers.push(worker);
        closing = first.close();
        await Promise.race([entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Lock removal did not begin"); })]);
        const result = await startResidentHost(options).then((host) => {
            second = host;
            return undefined;
        }, (error: unknown) => error);
        if (second !== undefined) {
            const other = await requestHostIdentity(inProcessWorkerSocket(home));
            if (other !== undefined) workers.push(other);
            release.resolve();
            await closing;
            expect(existsSync(lockPath)).toBe(true);
        }
        expect(result).toBeInstanceOf(HostSocketHeldError);
        release.resolve();
        await closing;
        expect(existsSync(lockPath)).toBe(false);
        expect(processIsAlive(worker.pid)).toBe(false);
    } finally {
        release.resolve();
        await closing?.catch(() => {});
        await second?.close().catch(() => {});
        await first?.close().catch(() => {});
        delayed.mockRestore();
        for (const worker of workers) {
            if (processIsAlive(worker.pid)) await stopWorkerProcess(worker);
            expect(processIsAlive(worker.pid)).toBe(false);
        }
        await rm(home, { recursive: true, force: true });
    }
}, 30_000);
