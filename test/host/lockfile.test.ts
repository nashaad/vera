import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";

import { createHostLockfile } from "../../src/host/lockfile.ts";

const temporaryDirectories: string[] = [];
const startedAt = "2026-07-17T12:00:00.000Z";

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("host atomically publishes one private lockfile", async () => {
    const path = temporaryLockPath();
    const lockfile = createTestLockfile(path);

    const record = await lockfile.publish();

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(path, ".."))).toEqual(["host.json"]);
    expect(await lockfile.read()).toEqual(record);
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "reader verifies the exact identity over a real Unix socket",
    async () => {
    const path = temporaryLockPath();
    const socketPath = join(path, "..", "..", "host.sock");
    const server = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.once("data", () => {
            socket.end(`${JSON.stringify({
                type: "host_identity",
                pid: 101,
                started_at: startedAt,
            })}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    try {
        const lockfile = createHostLockfile({
            path,
            socketPath,
            pid: 101,
            startedAt,
        });
        const record = await lockfile.publish();

        expect(await lockfile.read()).toEqual(record);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error));
        });
    }
    },
);

test("a dead host process makes the lock stale", async () => {
    const path = temporaryLockPath();
    await createTestLockfile(path).publish();
    const reader = createTestLockfile(path, {
        inspectSocket: async () => undefined,
    });

    expect(await reader.read()).toBeUndefined();
    expect(existsSync(path)).toBe(true);
});

test("a reused pid with a subsecond start mismatch makes the lock stale", async () => {
    const path = temporaryLockPath();
    await createTestLockfile(path).publish();
    const reader = createTestLockfile(path, {
        inspectSocket: async () => ({
            pid: 101,
            started_at: "2026-07-17T12:00:00.001Z",
        }),
    });

    expect(await reader.read()).toBeUndefined();
    expect(existsSync(path)).toBe(true);
});

test("a transient socket failure does not delete the lock", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();
    let attempts = 0;
    const reader = createTestLockfile(path, {
        inspectSocket: async () => {
            attempts += 1;
            return attempts > 1
                ? { pid: record.pid, started_at: record.started_at }
                : undefined;
        },
    });

    expect(await reader.read()).toBeUndefined();
    expect(existsSync(path)).toBe(true);
    expect(await reader.read()).toEqual(record);
});

test("a record for another socket is not accepted", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();
    writeFileSync(path, `${JSON.stringify({
        ...record,
        socket_path: "/tmp/not-vera.sock",
    })}\n`);
    let inspected = false;
    const reader = createTestLockfile(path, {
        inspectSocket: async () => {
            inspected = true;
            return { pid: record.pid, started_at: record.started_at };
        },
    });

    expect(await reader.read()).toBeUndefined();
    expect(inspected).toBe(false);
});

test("the socket owner replaces a stale lockfile", async () => {
    const path = temporaryLockPath();
    await createTestLockfile(path).publish();
    const replacementLockfile = createTestLockfile(path, {
        pid: 202,
        startedAt: "2026-07-17T12:02:00.000Z",
    });

    const replacement = await replacementLockfile.publish();

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
    expect(await replacementLockfile.read()).toEqual(replacement);
});

test("the socket owner replaces a malformed lockfile", async () => {
    const path = temporaryLockPath();
    await createTestLockfile(path).publish();
    writeFileSync(path, "partial json");
    const lockfile = createTestLockfile(path);

    expect(await lockfile.read()).toBeUndefined();
    const record = await lockfile.publish();

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
});

interface TestLockfileOverrides {
    readonly pid?: number;
    readonly startedAt?: string;
    readonly inspectSocket?: () => Promise<{
        readonly pid: number;
        readonly started_at: string;
    } | undefined>;
}

function createTestLockfile(
    path: string,
    overrides: TestLockfileOverrides = {},
) {
    return createHostLockfile({
        path,
        socketPath: "/tmp/vera-test.sock",
        pid: overrides.pid ?? 101,
        startedAt: overrides.startedAt ?? startedAt,
        inspectSocket: overrides.inspectSocket ?? (async () => ({
            pid: overrides.pid ?? 101,
            started_at: overrides.startedAt ?? startedAt,
        })),
    });
}

function temporaryLockPath(): string {
    const root = mkdtempSync(join("/private/tmp", "vera-host-lock-"));
    temporaryDirectories.push(root);
    return join(root, "host", "host.json");
}
