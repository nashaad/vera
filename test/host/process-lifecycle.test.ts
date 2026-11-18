import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    HOST_CLOSE_DEADLINE_MS,
    runResidentHostProcess,
} from "../../clients/host/process-lifecycle.ts";
import { DEFAULT_SIGTERM_GRACE_MS } from "../../src/host/force-stop.ts";
import type { HostLogEntry } from "../../src/host/host-log.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostShutdownIfIdle,
    type HostIdentity,
} from "../../src/host/protocol.ts";
import { socketTest } from "../support/socket-probe.ts";

test("an internal host shutdown closes and exits the dedicated process", async () => {
    const shutdown = Promise.withResolvers<void>();
    let closeCalls = 0;
    let disposed = false;
    const exits: number[] = [];
    const logged: HostLogEntry[] = [];
    const running = runResidentHostProcess({
        shutdownRequested: shutdown.promise,
        close: async () => {
            closeCalls += 1;
        },
    }, {
        waitForSignal: () => ({
            promise: new Promise<void>(() => {}),
            dispose: () => {
                disposed = true;
            },
        }),
        exit: (code) => exits.push(code),
        log: (entry) => logged.push(entry),
    });

    shutdown.resolve();
    await running;

    expect(closeCalls).toBe(1);
    expect(disposed).toBe(true);
    expect(exits).toEqual([0]);
    expect(logged).toEqual([{ type: "host_stopping", pid: process.pid, reason: "shutdown_requested" }]);
});

test("an OS shutdown signal closes before exiting the dedicated process", async () => {
    const signal = Promise.withResolvers<void>();
    const order: string[] = [];
    const logged: HostLogEntry[] = [];
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: async () => {
            order.push("closed");
        },
    }, {
        waitForSignal: () => ({
            promise: signal.promise,
            dispose: () => order.push("disposed"),
        }),
        exit: () => order.push("exited"),
        log: (entry) => logged.push(entry),
    });

    signal.resolve();
    await running;

    expect(order).toEqual(["disposed", "closed", "exited"]);
    expect(logged).toEqual([{ type: "host_stopping", pid: process.pid, reason: "signal" }]);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    test(`a starting host records ${signal} before its signal exit`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-start-signal-"));
        const ready = join(root, "ready");
        const child = Bun.spawn([process.execPath, "-e", `
            import { writeFileSync } from "node:fs";
            import { installStartupSignalLogging } from "./clients/host/process-lifecycle.ts";
            import { createHostLogger } from "./src/host/host-log.ts";
            installStartupSignalLogging(createHostLogger(), {
                pid: process.pid, started_at: new Date().toISOString(), build_id: "vera-test",
            });
            writeFileSync(${JSON.stringify(ready)}, "ready");
            setInterval(() => {}, 1000);
        `], {
            cwd: process.cwd(),
            env: { ...process.env, VERA_HOME: root },
            stdout: "ignore", stderr: "pipe",
        });
        try {
            const deadline = Date.now() + 5_000;
            while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
            expect(existsSync(ready)).toBe(true);
            child.kill(signal);
            await child.exited;
            expect(child.signalCode).toBe(signal);
            const entries = (await readFile(join(root, "runtime", "logs", "host.jsonl"), "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line));
            expect(entries).toEqual([expect.objectContaining({
                type: "host_stopping", role: "host", pid: child.pid, reason: "signal", signal,
            })]);
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await child.exited;
            }
            await rm(root, { recursive: true, force: true });
        }
    }, 10_000);

    test(`a host records ${signal} before exiting`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-signal-"));
        const ready = join(root, "ready");
        const child = Bun.spawn([process.execPath, "-e", `
            import { writeFileSync } from "node:fs";
            import { runResidentHostProcess } from "./clients/host/process-lifecycle.ts";
            const running = runResidentHostProcess({
                shutdownRequested: new Promise(() => {}),
                close: async () => {},
            });
            writeFileSync(${JSON.stringify(ready)}, "ready");
            await running;
        `], {
            cwd: process.cwd(),
            env: { ...process.env, VERA_HOME: root },
            stdout: "pipe",
            stderr: "pipe",
        });
        try {
            const deadline = Date.now() + 5_000;
            while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
                await Bun.sleep(10);
            }
            expect(existsSync(ready)).toBe(true);
            child.kill(signal);
            const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
            expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
            const entries = (await readFile(join(root, "runtime", "logs", "host.jsonl"), "utf8"))
                .trim().split("\n").map((line) => JSON.parse(line));
            expect(entries).toContainEqual(expect.objectContaining({
                type: "host_stopping", pid: child.pid, reason: "signal", signal,
            }));
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await child.exited;
            }
            await rm(root, { recursive: true, force: true });
        }
    }, 10_000);
}

test("a removed checkout closes and exits a development host", async () => {
    const removed = Promise.withResolvers<void>();
    const order: string[] = [];
    const logged: HostLogEntry[] = [];
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: async () => {
            order.push("closed");
        },
    }, {
        waitForSignal: () => ({
            promise: new Promise<void>(() => {}),
            dispose: () => order.push("signal disposed"),
        }),
        waitForCheckoutRemoval: () => ({
            promise: removed.promise,
            dispose: () => order.push("watch disposed"),
        }),
        exit: (code) => order.push(`exited ${code}`),
        log: (entry) => logged.push(entry),
    });

    removed.resolve();
    await running;

    expect(order).toEqual([
        "signal disposed",
        "watch disposed",
        "closed",
        "exited 0",
    ]);
    expect(logged).toEqual([{ type: "host_stopping", pid: process.pid, reason: "checkout_removed" }]);
});

test("a lost socket closes and exits the host", async () => {
    const lost = Promise.withResolvers<void>();
    const order: string[] = [];
    const logged: HostLogEntry[] = [];
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: async () => {
            order.push("closed");
        },
    }, {
        waitForSignal: () => ({
            promise: new Promise<void>(() => {}),
            dispose: () => order.push("signal disposed"),
        }),
        waitForSocketLoss: () => ({
            promise: lost.promise,
            dispose: () => order.push("socket watch disposed"),
        }),
        exit: (code) => order.push(`exited ${code}`),
        log: (entry) => logged.push(entry),
    });

    lost.resolve();
    await running;

    expect(order).toEqual([
        "signal disposed",
        "socket watch disposed",
        "closed",
        "exited 0",
    ]);
    expect(logged).toEqual([{ type: "host_stopping", pid: process.pid, reason: "socket_lost" }]);
});

test("a host whose close never finishes still exits after its deadline", async () => {
    const signal = Promise.withResolvers<void>();
    const exits: number[] = [];
    const logged: HostLogEntry[] = [];
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: () => new Promise<void>(() => {}),
    }, {
        waitForSignal: () => ({ promise: signal.promise, dispose: () => {} }),
        exit: (code) => exits.push(code),
        closeDeadlineMs: 20,
        log: (entry) => logged.push(entry),
    });

    signal.resolve();
    await running;

    expect(exits).toEqual([0]);
    expect(logged).toContainEqual(expect.objectContaining({ type: "host_close_timed_out", deadline_ms: 20 }));
});

test("a pool that cannot finish closing exits unsuccessfully and names its workers", async () => {
    const signal = Promise.withResolvers<void>();
    const exits: number[] = [];
    const logged: HostLogEntry[] = [];
    let handedOff = false;
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: () => new Promise<void>(() => {}),
    }, {
        waitForSignal: () => ({ promise: signal.promise, dispose: () => {} }),
        exit: (code) => exits.push(code),
        closeDeadlineMs: 20,
        poolWorkerPids: () => [177, 178],
        afterClose: async () => { handedOff = true; },
        log: (entry) => logged.push(entry),
    });

    signal.resolve();
    await running;

    expect(exits).toEqual([1]);
    expect(handedOff).toBe(false);
    expect(logged).toContainEqual(expect.objectContaining({
        type: "host_close_timed_out",
        error: "Could not confirm session process PID 177 stopped. Could not confirm session process PID 178 stopped.",
    }));
});

test("a failed pool close does not start the pending hand-off", async () => {
    const signal = Promise.withResolvers<void>();
    const exits: number[] = [];
    let handedOff = false;
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: async () => { throw new Error("Session process PID 177 is still running."); },
    }, {
        waitForSignal: () => ({ promise: signal.promise, dispose: () => {} }),
        exit: (code) => exits.push(code),
        poolWorkerPids: () => [177],
        afterClose: async () => { handedOff = true; },
    });

    signal.resolve();
    await running;

    expect(exits).toEqual([1]);
    expect(handedOff).toBe(false);
});

test("a failed close still runs the pending hand-off and exits 1", async () => {
    const signal = Promise.withResolvers<void>();
    const order: string[] = [];
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: async () => {
            order.push("close failed");
            throw new Error("registry close failed");
        },
    }, {
        waitForSignal: () => ({ promise: signal.promise, dispose: () => {} }),
        exit: (code) => order.push(`exited ${code}`),
        afterClose: async () => {
            order.push("after close");
        },
        log: () => {},
    });

    signal.resolve();
    await running;

    expect(order).toEqual(["close failed", "after close", "exited 1"]);
});

test("the host gives up closing before the installer gives up waiting", () => {
    expect(HOST_CLOSE_DEADLINE_MS).toBeLessThan(DEFAULT_SIGTERM_GRACE_MS);
});

socketTest(
    "protocol shutdown terminates the dedicated host process",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-process-lifecycle-"));
        const socketPath = join(root, "host.sock");
        const child = Bun.spawn([
            process.execPath,
            "test/support/disposable-resident-host.ts",
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                VERA_HOME: join(root, ".vera"),
                VERA_TEST_HOST_ROOT: root,
                VERA_TEST_HOST_SOCKET: socketPath,
            },
            stdout: "pipe",
            stderr: "pipe",
        });

        try {
            const identity = JSON.parse(
                await readFirstLine(child.stdout),
            ) as HostIdentity;
            expect(await requestHostShutdownIfIdle(
                socketPath,
                identity,
                HOST_PROTOCOL_VERSION + 1,
            )).toMatchObject({
                type: "shutdown_if_idle_accepted",
                pid: child.pid,
            });
            const exitCode = await Promise.race([
                child.exited,
                Bun.sleep(2_000).then(() => -1),
            ]);
            if (exitCode === -1) {
                child.kill("SIGKILL");
                await child.exited;
                throw new Error(
                    `Host did not exit after protocol shutdown: ${
                        await new Response(child.stderr).text()
                    }`,
                );
            }
            expect(exitCode).toBe(0);
        } finally {
            if (processIsAlive(child.pid)) child.kill("SIGKILL");
            await rm(root, { recursive: true, force: true });
        }
    },
);

async function readFirstLine(
    stream: ReadableStream<Uint8Array>,
): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) throw new Error("Host exited before reporting readiness");
            buffered += decoder.decode(value, { stream: true });
            const newline = buffered.indexOf("\n");
            if (newline !== -1) return buffered.slice(0, newline);
        }
    } finally {
        reader.releaseLock();
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

test("a hand-off that never finishes still exits the host", async () => {
    const signal = Promise.withResolvers<void>();
    const exits: number[] = [];
    const running = runResidentHostProcess({
        shutdownRequested: new Promise<void>(() => {}),
        close: async () => {},
    }, {
        waitForSignal: () => ({ promise: signal.promise, dispose: () => {} }),
        exit: (code) => exits.push(code),
        afterClose: () => new Promise<void>(() => {}),
        afterCloseDeadlineMs: 20,
        log: () => {},
    });

    signal.resolve();
    await running;

    expect(exits).toEqual([0]);
});
