import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostLockUnreadableError } from "../../src/host/lockfile.ts";
import { processStartedAt } from "../../src/host/process-identity.ts";
import { HostSocketHeldError, startHostServer } from "../../src/host/server.ts";
import { spawnVeraLookingProcess } from "../support/vera-looking-process.ts";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-takeover-"));
    directories.push(directory);
    return directory;
}

/** A socket that accepts connections and answers nothing: a wedged host. */
function listenSilently(socketPath: string): Promise<void> {
    const server = createServer(() => {});
    servers.push(server);
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
    });
}

test("a new host refuses to take a live host's silent socket", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    // A live process other than this one, with a matching start time: exactly
    // the shape of a host wedged mid-run. Sleep outlives the assertions.
    const owner = Bun.spawn(["sleep", "30"]);
    const startedAt = processStartedAt(owner.pid);
    expect(startedAt).toBeDefined();
    writeFileSync(lockPath, `${JSON.stringify({
        schema_version: 2,
        pid: owner.pid,
        started_at: new Date(startedAt as number).toISOString(),
        socket_path: socketPath,
    })}\n`);

    const attempt = startHostServer({
        socketPath,
        lockPath,
        pid: 4_242,
        startedAt: "2026-08-20T12:00:00.000Z",
    });

    await expect(attempt).rejects.toBeInstanceOf(HostSocketHeldError);
    await expect(attempt).rejects.toThrow("vera host stop --force");
    owner.kill();
});

test("a new host refuses a silent socket whose lockfile start time is not a time and whose owner looks like Vera", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    const owner = spawnVeraLookingProcess(directory);
    writeFileSync(lockPath, `${JSON.stringify({
        schema_version: 2,
        pid: owner.pid,
        started_at: "not a timestamp",
        socket_path: socketPath,
    })}\n`);

    try {
        await expect(startHostServer({
            socketPath,
            lockPath,
            pid: 4_242,
            startedAt: "2026-08-20T12:00:00.000Z",
        })).rejects.toBeInstanceOf(HostSocketHeldError);
        expect(owner.exitCode).toBeNull();
    } finally {
        owner.kill("SIGKILL");
        await owner.exited;
    }
});

test("a silent socket whose lockfile start time is not a time and whose owner is not Vera is taken over", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    const bystander = Bun.spawn(["sleep", "30"]);
    writeFileSync(lockPath, `${JSON.stringify({
        schema_version: 2,
        pid: bystander.pid,
        started_at: "not a timestamp",
        socket_path: socketPath,
    })}\n`);

    try {
        const host = await startHostServer({
            socketPath,
            lockPath,
            pid: 4_242,
            startedAt: "2026-08-20T12:00:00.000Z",
        });
        try {
            expect(host.socketPath).toBe(socketPath);
        } finally {
            await host.close();
        }
        expect(bystander.exitCode).toBeNull();
        expect(bystander.signalCode).toBeNull();
    } finally {
        bystander.kill("SIGKILL");
        await bystander.exited;
    }
});

test("a truly abandoned socket is still taken over", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    // No lockfile at all: nothing claims this socket, so it is debris.
    const host = await startHostServer({
        socketPath,
        lockPath,
        pid: 4_242,
        startedAt: "2026-08-20T12:00:00.000Z",
    });

    try {
        expect(host.socketPath).toBe(socketPath);
    } finally {
        await host.close();
    }
});

test("a socket whose recorded owner is dead is taken over", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    writeFileSync(lockPath, `${JSON.stringify({
        schema_version: 2,
        // A pid far above the system maximum is never live.
        pid: 2_147_483_646,
        started_at: "2026-08-20T12:00:00.000Z",
        socket_path: socketPath,
    })}\n`);

    const host = await startHostServer({
        socketPath,
        lockPath,
        pid: 4_242,
        startedAt: "2026-08-20T12:00:00.000Z",
    });

    try {
        expect(host.socketPath).toBe(socketPath);
    } finally {
        await host.close();
    }
});

test("a silent socket is kept when the lockfile is damaged and names a Vera-looking process", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    const owner = spawnVeraLookingProcess(directory);
    // No socket_path: the lock is damaged, so it cannot say the socket is debris.
    const source = JSON.stringify({ schema_version: 2, pid: owner.pid });
    writeFileSync(lockPath, source);

    try {
        const attempt = startHostServer({
            socketPath,
            lockPath,
            pid: 4_242,
            startedAt: "2026-08-20T12:00:00.000Z",
        });

        await expect(attempt).rejects.toBeInstanceOf(HostLockUnreadableError);
        await expect(attempt).rejects.toThrow(lockPath);
        expect(existsSync(socketPath)).toBe(true);
        expect(readFileSync(lockPath, "utf8")).toBe(source);
        expect(owner.exitCode).toBeNull();
    } finally {
        owner.kill("SIGKILL");
        await owner.exited;
    }
});

test("a silent socket is kept when the lockfile names no PID", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    writeFileSync(lockPath, "garbage");

    await expect(startHostServer({
        socketPath,
        lockPath,
        pid: 4_242,
        startedAt: "2026-08-20T12:00:00.000Z",
    })).rejects.toBeInstanceOf(HostLockUnreadableError);
    expect(existsSync(socketPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("garbage");
});

test("a silent socket is taken over when the damaged lockfile names a dead process", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const lockPath = join(directory, "host.json");
    await listenSilently(socketPath);
    writeFileSync(lockPath, JSON.stringify({ schema_version: 2, pid: 2_147_483_646 }));

    const host = await startHostServer({
        socketPath,
        lockPath,
        pid: 4_242,
        startedAt: "2026-08-20T12:00:00.000Z",
    });

    try {
        expect(host.socketPath).toBe(socketPath);
    } finally {
        await host.close();
    }
});
