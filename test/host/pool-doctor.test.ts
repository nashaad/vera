import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { inspectPoolHealth } from "../../clients/process-doctor.ts";
import { startHostServer, startWorkerServer } from "../../src/host/server.ts";

socketTest("doctor checks the host before reporting an unavailable session process", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs9-doctor-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const runtime = join(home, "runtime");
    const lockPath = join(runtime, "host.json");
    const startedAt = new Date().toISOString();
    const host = await startHostServer({
        socketPath: join(runtime, "host.sock"), lockPath, pid: process.pid, startedAt, buildId: "test", poolWorkerCount: 2,
    });
    const worker = await startWorkerServer({
        socketPath: join(runtime, "w0.sock"), lockPath, pid: process.pid, startedAt, buildId: "test",
    }, { id: "w0", index: 0, count: 2, generation: 1 });
    try {
        expect(await inspectPoolHealth(runtime)).toEqual({ hostFault: false, unavailableSessionProcesses: ["w1"] });
        await host.close();
        expect(await inspectPoolHealth(runtime)).toEqual({ hostFault: true, unavailableSessionProcesses: [] });
    } finally {
        await worker.close();
        await host.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});
