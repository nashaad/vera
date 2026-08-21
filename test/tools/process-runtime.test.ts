import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ManagedProcessRegistry,
    type ManagedProcessRunResult,
} from "../../src/tools/process-runtime.ts";

const ENV = process.env as Readonly<Record<string, string | undefined>>;

test("a yielded process survives its former turn signal and can be killed", async () => {
    const registry = new ManagedProcessRegistry({ id: () => "p-survives" });
    const scope = registry.scope("session-a");
    const turn = new AbortController();
    try {
        const result = await scope.run({
            command: "printf ready; sleep 60",
            cwd: process.cwd(),
            env: ENV,
            signal: turn.signal,
            yieldAfterMs: 20,
            interactive: false,
        });
        const running = expectRunning(result);
        expect(running.processId).toBe("p-survives");

        turn.abort(new Error("former turn ended"));
        const observed = await untilValue(() => {
            const snapshot = scope.read(running.processId);
            return snapshot?.status === "running"
                    && snapshot.output.includes("ready")
                ? snapshot
                : undefined;
        });
        expect(observed.status).toBe("running");

        const killed = await scope.kill(running.processId);
        expect(killed).toMatchObject({ status: "exited", processId: "p-survives" });
        expect(scope.read(running.processId)).toBeUndefined();
    } finally {
        await registry.close();
    }
});

test("an exited process is retained until its first completed read", async () => {
    const registry = new ManagedProcessRegistry({ id: () => "p-once" });
    const scope = registry.scope("session-a");
    try {
        const result = await scope.run({
            command: "printf done",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        });
        const processId = expectRunning(result).processId;
        const exited = await untilValue(() => {
            const snapshot = scope.read(processId);
            return snapshot?.status === "exited" ? snapshot : undefined;
        });
        expect(exited).toMatchObject({ exitCode: 0, output: "done" });
        expect(scope.read(processId)).toBeUndefined();
    } finally {
        await registry.close();
    }
});

test("an unread exited process expires from the registry", async () => {
    const registry = new ManagedProcessRegistry({
        exitRetentionMs: 30,
        id: () => "p-expires",
    });
    const scope = registry.scope("session-a");
    try {
        const result = await scope.run({
            command: "printf done",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        });
        const processId = expectRunning(result).processId;
        await untilValue(() => registry.hasLiveProcesses() ? undefined : true);
        await Bun.sleep(40);
        expect(scope.read(processId)).toBeUndefined();
    } finally {
        await registry.close();
    }
});

test("the live-process cap refuses a new command without disturbing the old one", async () => {
    let sequence = 0;
    const registry = new ManagedProcessRegistry({
        maxLivePerOwner: 1,
        maxRetainedPerOwner: 2,
        id: () => `p-${++sequence}`,
    });
    const scope = registry.scope("session-a");
    try {
        const first = await scope.run({
            command: "sleep 60",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        });
        const processId = expectRunning(first).processId;
        const second = await scope.run({
            command: "printf should-not-run",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        });
        expect(second).toEqual({
            kind: "rejected",
            reason: "Process limit reached (1 live for this session).",
        });
        expect(scope.read(processId)?.status).toBe("running");
        await scope.kill(processId);
    } finally {
        await registry.close();
    }
});

test("process ids cannot cross session scopes", async () => {
    const registry = new ManagedProcessRegistry({ id: () => "p-private" });
    const owner = registry.scope("session-a");
    const other = registry.scope("session-b");
    try {
        const result = await owner.run({
            command: "sleep 60",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        });
        const processId = expectRunning(result).processId;
        expect(other.read(processId)).toBeUndefined();
        expect(await other.kill(processId)).toBeUndefined();
        expect(owner.read(processId)?.status).toBe("running");
        await owner.kill(processId);
    } finally {
        await registry.close();
    }
});

test("interactive input is a spawn-time choice and is rejected until writes exist", async () => {
    const registry = new ManagedProcessRegistry();
    const scope = registry.scope("session-a");
    try {
        const result = await scope.run({
            command: "read value",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: true,
        });
        expect(result).toEqual({
            kind: "rejected",
            reason: "Interactive process input is not available in this build.",
        });
        expect(registry.hasLiveProcesses()).toBe(false);
    } finally {
        await registry.close();
    }
});

test("registry shutdown kills the whole managed process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-process-tree-"));
    const pidFile = join(root, "grandchild-pid");
    const registry = new ManagedProcessRegistry();
    const scope = registry.scope("session-a");
    try {
        const result = await scope.run({
            command: `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`,
            cwd: root,
            env: ENV,
            yieldAfterMs: 20,
            interactive: false,
        });
        expectRunning(result);
        const grandchild = await untilValue(async () => {
            try {
                return Number((await readFile(pidFile, "utf8")).trim()) || undefined;
            } catch {
                return undefined;
            }
        });
        process.kill(grandchild, 0);

        await registry.close();
        await untilValue(() => {
            try {
                process.kill(grandchild, 0);
                return undefined;
            } catch {
                return true;
            }
        });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a descendant holding pipes after its shell exits remains manageable", async () => {
    const registry = new ManagedProcessRegistry();
    const scope = registry.scope("session-a");
    try {
        const result = await scope.run({
            command: "sleep 60 &",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 20,
            interactive: false,
        });
        const processId = expectRunning(result).processId;
        const killed = await scope.kill(processId);
        expect(killed?.status).toBe("exited");
    } finally {
        await registry.close();
    }
});

test("a redirected background child remains owned after its shell exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-redirected-child-"));
    const pidFile = join(root, "child-pid");
    const registry = new ManagedProcessRegistry();
    const scope = registry.scope("session-a");
    try {
        const result = await scope.run({
            command:
                `sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}`,
            cwd: root,
            env: ENV,
            yieldAfterMs: 20,
            interactive: false,
        });
        const running = expectRunning(result);
        const child = await untilValue(async () => {
            try {
                return Number((await readFile(pidFile, "utf8")).trim()) || undefined;
            } catch {
                return undefined;
            }
        });

        // Both inherited pipes are closed and the launcher is gone. The
        // process group is the remaining evidence of owned work.
        await Bun.sleep(75);
        expect(scope.read(running.processId)?.status).toBe("running");
        process.kill(child, 0);

        await scope.close();
        await untilValue(() => processIsGone(child) ? true : undefined);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed kill returns within its bound and remains truthful", async () => {
    const registry = new ManagedProcessRegistry({
        stopWaitMs: 30,
        signalProcessTree: () => "simulated signal failure",
    });
    const scope = registry.scope("session-a");
    let pid: number | undefined;
    try {
        const running = expectRunning(await scope.run({
            command: "sleep 60",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        }));
        pid = running.pid;
        const startedAt = performance.now();
        const result = await scope.kill(running.processId);

        expect(performance.now() - startedAt).toBeLessThan(500);
        expect(result).toMatchObject({
            status: "running",
            terminationError: "simulated signal failure",
        });
        expect(scope.read(running.processId)?.status).toBe("running");
    } finally {
        if (pid !== undefined) {
            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                // It may have exited between the assertion and cleanup.
            }
        }
        await registry.close();
    }
});

test("process ids carry a full host generation", async () => {
    const registry = new ManagedProcessRegistry({ generation: "host-generation-a" });
    const scope = registry.scope("session-a");
    try {
        const running = expectRunning(await scope.run({
            command: "sleep 60",
            cwd: process.cwd(),
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        }));
        expect(running.processId).toBe("p-host-generation-a-1");
        await scope.kill(running.processId);
    } finally {
        await registry.close();
    }
});

test("process id allocation fails before command spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-process-id-"));
    const marker = join(root, "spawned");
    const registry = new ManagedProcessRegistry({ id: () => "" });
    const scope = registry.scope("session-a");
    try {
        await expect(scope.run({
            command: `touch ${JSON.stringify(marker)}`,
            cwd: root,
            env: ENV,
            yieldAfterMs: 0,
            interactive: false,
        })).rejects.toThrow("Could not allocate a unique process id");
        await expect(stat(marker)).rejects.toThrow();
        expect(registry.hasLiveProcesses()).toBe(false);
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("process output is bounded while preserving its head and tail", async () => {
    const registry = new ManagedProcessRegistry();
    const scope = registry.scope("session-a");
    try {
        const result = await scope.run({
            command:
                "printf HEADMARK; yes x | head -c 1048576; printf TAILMARK",
            cwd: process.cwd(),
            env: ENV,
            interactive: false,
        });
        expect(result.kind).toBe("exited");
        if (result.kind !== "exited") throw new Error("expected exited process");
        expect(result.snapshot.output).toStartWith("HEADMARK");
        expect(result.snapshot.output).toContain(
            "bytes omitted from the middle of process output",
        );
        expect(result.snapshot.output).toEndWith("TAILMARK");
        expect(Buffer.byteLength(result.snapshot.output)).toBeLessThan(72 * 1024);
    } finally {
        await registry.close();
    }
});

function expectRunning(result: ManagedProcessRunResult) {
    expect(result.kind).toBe("running");
    if (result.kind !== "running") throw new Error("expected running process");
    return result.snapshot;
}

async function untilValue<T>(
    read: () => T | undefined | Promise<T | undefined>,
    timeoutMs = 2_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error("condition did not hold in time");
        await Bun.sleep(10);
    }
}

function processIsGone(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch {
        return true;
    }
}
