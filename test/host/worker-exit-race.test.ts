import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultHostSocketPath } from "../../src/host/lockfile.ts";
import { processIsAlive } from "../../src/host/process-identity.ts";
import { testTempBase } from "../support/temp-root.ts";

// This ps kills the pid it is asked about and waits until the pid is gone
// before failing: the worker exits between the liveness check and the ps read.
const VANISHING_PS = [
    "#!/bin/sh",
    "kill -9 \"$2\" 2>/dev/null",
    "i=0",
    "while kill -0 \"$2\" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.01; i=$((i+1)); done",
    "exit 1",
    "",
].join("\n");

const UNREADABLE_PS = "#!/bin/sh\nexit 1\n";

const STOP = "import { stopWorkerProcess } from './src/host/pool/stop-worker.ts';"
    + " await stopWorkerProcess({ pid: Number(process.env.WORKER_PID), started_at: new Date().toISOString() });";
const KILL = "import { killWorkerProcess } from './src/host/pool/stop-worker.ts';"
    + " killWorkerProcess({ pid: Number(process.env.WORKER_PID), started_at: new Date().toISOString() });";
const ASSERT_STOPPED = "import { assertRecordedWorkersStopped } from './src/host/pool/worker-records.ts';"
    + " await assertRecordedWorkersStopped(process.env.WORKER_HOME);";

interface Outcome {
    readonly exitCode: number;
    readonly stderr: string;
}

interface Race {
    readonly pid: number;
    readonly home: string;
    run(code: string): Promise<Outcome>;
}

// Not a child of the test process, so a killed sleeper is reaped at once.
function orphanSleeper(): number {
    const result = Bun.spawnSync(["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"]);
    const pid = Number(result.stdout.toString().trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("orphan sleeper did not start");
    return pid;
}

async function withFakePs(script: string, body: (race: Race) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(testTempBase(), "worker-exit-race-"));
    writeFileSync(join(root, "ps"), script, { mode: 0o755 });
    const home = join(root, "home");
    const workers = join(dirname(defaultHostSocketPath(home)), "workers");
    mkdirSync(workers, { recursive: true });
    const pid = orphanSleeper();
    writeFileSync(join(workers, "w0.json"), JSON.stringify({ id: "w0", pid, started_at: new Date().toISOString() }));
    const run = async (code: string): Promise<Outcome> => {
        const child = Bun.spawn([process.execPath, "-e", code], {
            cwd: process.cwd(),
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, WORKER_PID: String(pid), WORKER_HOME: home },
            stdout: "ignore",
            stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        return { exitCode, stderr };
    };
    try {
        await body({ pid, home, run });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("@core stopping a worker that exits while its start time is read succeeds", async () => {
    await withFakePs(VANISHING_PS, async ({ pid, run }) => {
        const outcome = await run(STOP);
        expect(outcome.stderr).not.toContain("Could not confirm");
        expect(outcome.exitCode).toBe(0);
        expect(processIsAlive(pid)).toBe(false);
    });
});

test("the stopped check passes for a recorded worker that exits while it is read", async () => {
    await withFakePs(VANISHING_PS, async ({ pid, run }) => {
        const outcome = await run(ASSERT_STOPPED);
        expect(outcome.stderr).not.toContain("Could not confirm");
        expect(outcome.exitCode).toBe(0);
        expect(processIsAlive(pid)).toBe(false);
    });
});

test("killing a worker that exits while its start time is read does nothing", async () => {
    await withFakePs(VANISHING_PS, async ({ pid, run }) => {
        const outcome = await run(KILL);
        expect(outcome.stderr).not.toContain("Could not confirm");
        expect(outcome.exitCode).toBe(0);
        expect(processIsAlive(pid)).toBe(false);
    });
});

test("a running worker whose start time cannot be read still fails the stopped check", async () => {
    await withFakePs(UNREADABLE_PS, async ({ pid, run }) => {
        try {
            const outcome = await run(ASSERT_STOPPED);
            expect(outcome.exitCode).toBe(1);
            expect(outcome.stderr).toContain(`Could not confirm session process PID ${pid} stopped.`);
            expect(processIsAlive(pid)).toBe(true);
        } finally {
            process.kill(pid, "SIGKILL");
        }
    });
});
