import { expect, spyOn, test } from "bun:test";

import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";

const signalProcess = process.kill.bind(process);

function processExists(pid: number): boolean {
    try {
        signalProcess(pid, 0);
        return true;
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
            return false;
        }
        throw error;
    }
}

async function waitUntil(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!condition()) {
        if (performance.now() >= deadline) throw new Error("condition did not hold in time");
        await Bun.sleep(5);
    }
}

test.skipIf(process.platform === "win32")("@core the default probe tracks a group after its leader exits without spawning ps", async () => {
    let pid: number | undefined;
    const registry = new ManagedProcessRegistry({
        maxLivePerOwner: 1,
        onProcessStarted(startedPid) { pid ??= startedPid; },
    });
    const scope = registry.scope("group-probe");
    const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
        throw new Error("spawn unavailable");
    });
    const kill = spyOn(process, "kill");
    try {
        const result = await scope.run({
            command: "exec sh -c 'sleep 0.5 & exit 0' </dev/null >/dev/null 2>&1",
            cwd: process.cwd(),
            env: process.env,
            yieldAfterMs: 0,
            interactive: false,
        });
        expect(result.kind).toBe("running");
        if (result.kind !== "running") throw new Error("expected a running group");
        const groupPid = result.snapshot.pid;
        await waitUntil(() => !processExists(groupPid));
        expect(processExists(-groupPid)).toBe(true);
        await waitUntil(() => kill.mock.calls.some(([target, signal]) => target === -groupPid && signal === 0));
        expect(scope.read(result.snapshot.processId)?.status).toBe("running");
        expect(registry.liveCount("group-probe")).toBe(1);

        await waitUntil(() => !processExists(-groupPid));
        await waitUntil(() => scope.read(result.snapshot.processId)?.status === "exited");
        expect(registry.liveCount("group-probe")).toBe(0);
        const next = await scope.run({
            command: "exit 0",
            cwd: process.cwd(),
            env: process.env,
            interactive: false,
        });
        expect(next.kind).toBe("exited");
        expect(spawnSync).not.toHaveBeenCalled();
    } finally {
        kill.mockRestore();
        spawnSync.mockRestore();
        try {
            if (pid !== undefined) {
                const groupPid = pid;
                await waitUntil(() => !processExists(-groupPid), 3_000);
            }
        } finally {
            await registry.close();
        }
    }
});

for (const code of ["EPERM", "EIO"]) {
    test.skipIf(process.platform === "win32")(`@core the default probe falls back to ps on ${code}`, async () => {
        let pid: number | undefined;
        let denied = 0;
        const registry = new ManagedProcessRegistry({
            onProcessStarted(startedPid) { pid = startedPid; },
        });
        const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
            if (pid !== undefined && target === -pid && signal === 0) {
                denied += 1;
                throw Object.assign(new Error("signal probe failed"), { code });
            }
            return signalProcess(target, signal);
        });
        const spawnSync = spyOn(Bun, "spawnSync");
        try {
            const result = await registry.scope("group-probe").run({
                command: "exit 0",
                cwd: process.cwd(),
                env: process.env,
                interactive: false,
            });
            expect(result.kind).toBe("exited");
            expect(denied).toBeGreaterThan(0);
            expect(spawnSync.mock.calls.some(([command]) =>
                Array.isArray(command)
                && command[0] === "ps"
                && command[1] === "-axo"
                && command[2] === "pgid="
            )).toBe(true);
        } finally {
            kill.mockRestore();
            spawnSync.mockRestore();
            await registry.close();
        }
    });
}
