import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { createHostLockfile } from "../../src/host/lockfile.ts";
import { startHostServer } from "../../src/host/server.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host listens privately, publishes its identity, and becomes stale on close",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const lockPath = join(directory, "host.json");
        const lockfile = createHostLockfile({ socketPath, path: lockPath });
        const server = await startHostServer({
            socketPath,
            lockPath,
            pid: 101,
            startedAt: "2026-07-17T12:00:00.123Z",
        });

        try {
            expect(statSync(directory).mode & 0o777).toBe(0o700);
            expect(statSync(socketPath).mode & 0o777).toBe(0o600);
            expect(await lockfile.read()).toEqual(server.lock);
        } finally {
            await server.close();
        }

        expect(await lockfile.read()).toBeUndefined();
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "host times out incomplete requests",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
        });
        const socket = createConnection(socketPath);
        let drip: ReturnType<typeof setInterval> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", () => {
                    socket.write("{\"type\":");
                    drip = setInterval(() => socket.write(" "), 100);
                });
                socket.once("close", () => {
                    clearInterval(drip);
                    resolve();
                });
                socket.once("error", reject);
            });
        } finally {
            clearInterval(drip);
            socket.destroy();
            await server.close();
        }
    },
    2_000,
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "closing an old host does not unlink a replacement socket",
    async () => {
        const directory = temporaryHostDirectory();
        const socketPath = join(directory, "host.sock");
        const oldHost = await startHostServer({
            socketPath,
            lockPath: join(directory, "old.json"),
        });
        unlinkSync(socketPath);
        const replacement = createServer();
        await new Promise<void>((resolve, reject) => {
            replacement.once("error", reject);
            replacement.listen(socketPath, resolve);
        });
        try {
            await oldHost.close();
            expect(statSync(socketPath).isSocket()).toBeTrue();
        } finally {
            await new Promise<void>((resolve, reject) => {
                replacement.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
        }
    },
);

function temporaryHostDirectory(): string {
    const directory = mkdtempSync(join("/private/tmp", "vera-host-server-"));
    temporaryDirectories.push(directory);
    return directory;
}
