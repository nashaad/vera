import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { requestHostShutdownForReplacement } from "../../src/host/protocol.ts";
import { startHostServer } from "../../src/host/server.ts";

async function waitForFile(path: string): Promise<string> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        try {
            return await readFile(path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await Bun.sleep(25);
    }
    throw new Error(`File was not restored: ${path}`);
}

async function start(directory: string, log: Record<string, unknown>[] = []) {
    return startHostServer({
        socketPath: join(directory, "host.sock"),
        lockPath: join(directory, "host.json"),
        startedAt: "2026-01-02T03:04:05.000Z",
        log: (entry) => { log.push(entry); },
    });
}

test("@core host restores its exact lock record and logs restoration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-lock-restore-"));
    const log: Record<string, unknown>[] = [];
    const server = await start(directory, log);
    const lockPath = join(directory, "host.json");
    try {
        const original = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        await unlink(lockPath);
        const restored = JSON.parse(await waitForFile(lockPath)) as Record<string, unknown>;
        expect(restored).toEqual(original);
        expect(restored).toMatchObject({ pid: process.pid, started_at: "2026-01-02T03:04:05.000Z" });
        const deadline = Date.now() + 5_000;
        while (!log.some((entry) => entry.type === "host_lock_restored") && Date.now() < deadline) {
            await Bun.sleep(25);
        }
        expect(log.filter((entry) => entry.type === "host_lock_restored")).toEqual([
            expect.objectContaining({ pid: process.pid, started_at: "2026-01-02T03:04:05.000Z" }),
        ]);
    } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("@core host does not restore when the public socket was replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-lock-socket-"));
    const server = await start(directory);
    const lockPath = join(directory, "host.json");
    const socketPath = join(directory, "host.sock");
    const replacement = createServer();
    try {
        await unlink(lockPath);
        await unlink(socketPath);
        await new Promise<void>((resolve, reject) => {
            replacement.once("error", reject);
            replacement.listen(socketPath, resolve);
        });
        await Bun.sleep(1_100);
        await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await new Promise<void>((resolve) => replacement.close(() => resolve()));
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("@core host does not recreate a removed socket directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-lock-directory-"));
    const server = await start(directory);
    try {
        await rm(directory, { recursive: true });
        await Bun.sleep(1_100);
        await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("@core host leaves damaged and other-host lock files untouched", async () => {
    for (const contents of ["{damaged", JSON.stringify({ pid: process.pid + 1, started_at: "other" })]) {
        const directory = await mkdtemp(join(tmpdir(), "host-lock-existing-"));
        const server = await start(directory);
        const lockPath = join(directory, "host.json");
        try {
            await unlink(lockPath);
            await writeFile(lockPath, contents);
            await Bun.sleep(1_100);
            expect(await readFile(lockPath, "utf8")).toBe(contents);
        } finally {
            await server.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
});

test("@core refused replacement resumes lock restoration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-lock-refused-replacement-"));
    const server = await startHostServer({
        socketPath: join(directory, "host.sock"),
        lockPath: join(directory, "host.json"),
        startedAt: "2026-01-02T03:04:05.000Z",
        canReplace: () => false,
    });
    const lockPath = join(directory, "host.json");
    try {
        await unlink(lockPath);
        const response = await requestHostShutdownForReplacement(
            server.socketPath,
            server.identity,
        );
        expect(response?.type).toBe("shutdown_for_replacement_refused");
        expect(JSON.parse(await waitForFile(lockPath))).toEqual(server.lock);
    } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("a refused replacement cannot restart restoration during final shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-lock-shutdown-race-"));
    const entered = Promise.withResolvers<void>();
    const finishReplacement = Promise.withResolvers<void>();
    const server = await startHostServer({
        socketPath: join(directory, "host.sock"),
        lockPath: join(directory, "host.json"),
        canReplace: async () => {
            entered.resolve();
            await finishReplacement.promise;
            return false;
        },
    });
    const lockPath = join(directory, "host.json");
    try {
        await unlink(lockPath);
        const request = requestHostShutdownForReplacement(server.socketPath, server.identity);
        await entered.promise;
        await server.stopLockRestoration();
        finishReplacement.resolve();
        expect((await request)?.type).toBe("shutdown_for_replacement_refused");
        await Bun.sleep(1_100);
        await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        finishReplacement.resolve();
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("@core shutdown permanently stops lock restoration and leaves a deleted lock absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-lock-shutdown-"));
    const server = await start(directory);
    const lockPath = join(directory, "host.json");
    try {
        await unlink(lockPath);
        await server.stopLockRestoration();
        await Bun.sleep(1_100);
        await server.close();
        await Bun.sleep(1_100);
        await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});
