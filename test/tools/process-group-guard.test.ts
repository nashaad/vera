import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { processIsAlive, processStartedAt } from "../../src/host/process-identity.ts";
import { signalVerifiedProcess, type ProcessGroupIdentity } from "../../src/process-group.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";

test("a tool stops a live group whose leader has exited", async () => {
    const root = await mkdtemp(join(process.env.VERA_TEST_TEMP_BASE!, "group-guard-"));
    const pidPath = join(root, "child-pid");
    const registry = new ManagedProcessRegistry({ stopWaitMs: 150 });
    const scope = registry.scope("session-a");
    let child: ProcessGroupIdentity | undefined;
    try {
        const result = await scope.run({
            command: `sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidPath)}`,
            cwd: root,
            env: process.env,
            yieldAfterMs: 20,
            interactive: false,
        });
        expect(result.kind).toBe("running");
        if (result.kind !== "running") throw new Error("expected a running group");
        const deadline = Date.now() + 3_000;
        while (child === undefined && Date.now() < deadline) {
            const value = await readFile(pidPath, "utf8").catch(() => "");
            const pid = Number(value.trim());
            const startedAt = pid > 0 ? processStartedAt(pid) : undefined;
            if (startedAt !== undefined) child = { pid, started_at: new Date(startedAt).toISOString() };
            else await Bun.sleep(10);
        }
        if (child === undefined) throw new Error("background process did not start");
        while (processIsAlive(result.snapshot.pid) && Date.now() < deadline) await Bun.sleep(10);
        expect(processIsAlive(result.snapshot.pid)).toBe(false);
        const stopped = await scope.kill(result.snapshot.processId);
        expect(stopped?.status).toBe("exited");
        while (processIsAlive(child.pid) && Date.now() < deadline) await Bun.sleep(10);
        expect(processIsAlive(child.pid)).toBe(false);
    } finally {
        if (child !== undefined) {
            const result = signalVerifiedProcess(child, "SIGKILL");
            expect(["sent", "gone"]).toContain(result);
            const deadline = Date.now() + 3_000;
            while (processIsAlive(child.pid) && Date.now() < deadline) await Bun.sleep(10);
            expect(processIsAlive(child.pid)).toBe(false);
        }
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
}, 10_000);
