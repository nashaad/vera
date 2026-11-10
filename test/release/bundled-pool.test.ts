import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readRecordedWorkers } from "../../src/host/pool/worker-records.ts";
import { processCommandLine } from "../../src/host/process-identity.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { createFixture, processAlive, readHostLock, waitUntil } from "../support/handoff-e2e.ts";

test("a compiled host launches and stops its compiled session worker", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.host = { workers: 1 };
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(join(fixture.build1Root, ".git"));
    const home = join(fixture.home, "user");
    mkdirSync(home);
    const child = Bun.spawn([join(fixture.build1Root, "host"), "--pool", "--no-discovery"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            HOME: home,
            VERA_HOME: fixture.home,
            VERA_DEV_INSTANCE: "onebin dev",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    let workerPid: number | undefined;
    try {
        const ready = await Promise.race([
            child.stdout.getReader().read(),
            Bun.sleep(20_000).then(() => undefined),
        ]);
        if (ready === undefined || ready.done || !new TextDecoder().decode(ready.value).includes("Session worker ready")) {
            throw new Error("compiled host did not report worker readiness");
        }
        await waitUntil(() => readHostLock(fixture.home) !== undefined || child.exitCode !== null, 20_000, "compiled host lock");
        if (child.exitCode !== null) {
            throw new Error(`compiled host exited: ${await new Response(child.stderr).text()}`);
        }
        const lock = readHostLock(fixture.home)!;
        let workers = await readRecordedWorkers(fixture.home);
        const deadline = Date.now() + 20_000;
        while (workers.length !== 1 && Date.now() < deadline) {
            await Bun.sleep(100);
            workers = await readRecordedWorkers(fixture.home);
        }
        expect(workers).toHaveLength(1);
        workerPid = workers[0]!.pid;
        expect(processCommandLine(workerPid)).toContain("--vera-role=session-worker");
        const identity = await requestHostIdentity(join(fixture.home, "runtime", "host.sock"));
        expect(identity?.pid).toBe(lock.pid);
        expect(readFileSync(join(fixture.build1Root, "host"), "utf8")).toContain("--vera-role=host");
    } finally {
        try {
            if (workerPid === undefined) workerPid = (await readRecordedWorkers(fixture.home))[0]?.pid;
            if (child.exitCode === null) child.kill("SIGTERM");
            const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
            if (!exited) { child.kill("SIGKILL"); await child.exited; }
            if (workerPid !== undefined && processAlive(workerPid)) {
                process.kill(workerPid, "SIGTERM");
                await waitUntil(() => !processAlive(workerPid!), 10_000, "compiled worker exit");
            }
        } finally {
            fixture.cleanup();
        }
    }
}, 120_000);
