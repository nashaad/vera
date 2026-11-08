import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { inspectPoolHealth } from "../../clients/process-doctor.ts";
import { startHostServer, startWorkerServer } from "../../src/host/server.ts";

test("doctor checks the master before reporting an unavailable session process", async () => {
    const home = await mkdtemp("/private/tmp/vera-dev/hs9-doctor-");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const runtime = join(home, "runtime");
    const lockPath = join(runtime, "host.json");
    const startedAt = new Date().toISOString();
    const master = await startHostServer({
        socketPath: join(runtime, "host.sock"), lockPath, pid: process.pid, startedAt, buildId: "test", poolWorkerCount: 2,
    });
    const worker = await startWorkerServer({
        socketPath: join(runtime, "w0.sock"), lockPath, pid: process.pid, startedAt, buildId: "test",
    }, { id: "w0", index: 0, count: 2, generation: 1 });
    try {
        expect(await inspectPoolHealth(runtime)).toEqual({ hostFault: false, unavailableSessionProcesses: ["w1"] });
        await master.close();
        expect(await inspectPoolHealth(runtime)).toEqual({ hostFault: true, unavailableSessionProcesses: [] });
    } finally {
        await worker.close();
        await master.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});
