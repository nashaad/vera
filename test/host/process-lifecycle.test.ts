import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runResidentHostProcess } from "../../clients/host/process-lifecycle.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostShutdownIfIdle,
    type HostIdentity,
} from "../../src/host/protocol.ts";

test("an internal host shutdown closes and exits the dedicated process", async () => {
    const shutdown = Promise.withResolvers<void>();
    let closeCalls = 0;
    let disposed = false;
    const exits: number[] = [];
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
    });

    shutdown.resolve();
    await running;

    expect(closeCalls).toBe(1);
    expect(disposed).toBe(true);
    expect(exits).toEqual([0]);
});

test("an OS shutdown signal closes before exiting the dedicated process", async () => {
    const signal = Promise.withResolvers<void>();
    const order: string[] = [];
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
    });

    signal.resolve();
    await running;

    expect(order).toEqual(["disposed", "closed", "exited"]);
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
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
