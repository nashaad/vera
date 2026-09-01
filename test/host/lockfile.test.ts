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

import {
    createHostLockfile,
    defaultHostLockPath,
    defaultHostSocketPath,
    HostProtocolMismatchError,
} from "../../src/host/lockfile.ts";
import {
    VERA_HOME_ENV,
} from "../../src/profile-paths.ts";
import {
    HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
    HOST_PROTOCOL_VERSION,
} from "../../src/host/protocol.ts";

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
                protocol_version: HOST_PROTOCOL_VERSION,
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
            protocol_version: HOST_PROTOCOL_VERSION,
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
                ? {
                    pid: record.pid,
                    started_at: record.started_at,
                    protocol_version: HOST_PROTOCOL_VERSION,
                }
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

test("the daily socket is the home runtime socket, including a long home", () => {
    const previousHome = process.env[VERA_HOME_ENV];
    const home = join(
        "/tmp",
        "vera-fixed-endpoint-home-with-a-very-long-directory-name-that-used-to-relocate-the-socket",
    );
    process.env[VERA_HOME_ENV] = home;
    try {
        expect(defaultHostSocketPath()).toBe(join(home, "runtime", "host.sock"));
        expect(defaultHostLockPath()).toBe(join(home, "runtime", "host.json"));
    } finally {
        if (previousHome === undefined) delete process.env[VERA_HOME_ENV];
        else process.env[VERA_HOME_ENV] = previousHome;
    }
});

test("a live legacy host is incompatible rather than stale", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();
    const reader = createTestLockfile(path, {
        inspectSocket: async () => ({
            pid: record.pid,
            started_at: record.started_at,
        }),
    });

    await expect(reader.read()).rejects.toBeInstanceOf(
        HostProtocolMismatchError,
    );
    await expect(reader.read()).rejects.toThrow(
        "stop it and relaunch Vera",
    );
});

test("the current host stays reusable and the prior protocol is rejected", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();
    const reader = createTestLockfile(path, {
        inspectSocket: async () => ({
            pid: record.pid,
            started_at: record.started_at,
            protocol_version: HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
        }),
    });
    const tooOld = createTestLockfile(path, {
        inspectSocket: async () => ({
            pid: record.pid,
            started_at: record.started_at,
            protocol_version: HOST_MIN_COMPATIBLE_PROTOCOL_VERSION - 1,
        }),
    });

    expect(await reader.read()).toEqual(record);
    await expect(tooOld.read()).rejects.toBeInstanceOf(
        HostProtocolMismatchError,
    );
});

test("a newer host can advertise compatibility with this client", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();
    const compatible = createTestLockfile(path, {
        inspectSocket: async () => ({
            pid: record.pid,
            started_at: record.started_at,
            protocol_version: HOST_PROTOCOL_VERSION + 1,
            minimum_compatible_protocol_version:
                HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
        }),
    });
    const unknown = createTestLockfile(path, {
        inspectSocket: async () => ({
            pid: record.pid,
            started_at: record.started_at,
            protocol_version: HOST_PROTOCOL_VERSION + 1,
        }),
    });

    expect(await compatible.read()).toEqual(record);
    await expect(unknown.read()).rejects.toBeInstanceOf(
        HostProtocolMismatchError,
    );
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "reader reuses a compatible identity over a real Unix socket",
    async () => {
        const path = temporaryLockPath();
        const socketPath = join(path, "..", "..", "compatible.sock");
        const server = createServer((socket) => {
            socket.once("data", () => {
                socket.end(`${JSON.stringify({
                    type: "host_identity",
                    pid: 101,
                    started_at: startedAt,
                    protocol_version:
                        HOST_MIN_COMPATIBLE_PROTOCOL_VERSION,
                })}\n`);
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        const lockfile = createHostLockfile({
            path,
            socketPath,
            pid: 101,
            startedAt,
        });

        try {
            const record = await lockfile.publish();
            expect(await lockfile.read()).toEqual(record);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "reader recognizes a legacy identity over a real Unix socket",
    async () => {
        const path = temporaryLockPath();
        const socketPath = join(path, "..", "..", "legacy.sock");
        const server = createServer((socket) => {
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
            await lockfile.publish();
            await expect(lockfile.read()).rejects.toBeInstanceOf(
                HostProtocolMismatchError,
            );
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined
                    ? resolve()
                    : reject(error));
            });
        }
    },
);

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

test("the record carries the host build id", async () => {
    const path = temporaryLockPath();
    const lockfile = createTestLockfile(path, {
        buildId: "vera-host-b",
    });

    const record = await lockfile.publish();

    expect(record.build_id).toBe("vera-host-b");
    expect(record.schema_version).toBe(3);
    expect(await createTestLockfile(path).read()).toEqual(record);
});

test("the record can carry a boot cwd as a diagnostic", async () => {
    const path = temporaryLockPath();
    const lockfile = createTestLockfile(path, {
        projectRoot: "/checkouts/project-a",
    });

    const record = await lockfile.publish();

    expect(record.project_root).toBe("/checkouts/project-a");
    expect(await createTestLockfile(path).read()).toEqual(record);
});

test("a published record always includes a build id", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();

    expect(typeof record.build_id).toBe("string");
    expect(record.build_id?.length).toBeGreaterThan(0);
    expect(await createTestLockfile(path).read()).toEqual(record);
});

test("a version-1 record without a build id stays valid", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();
    const { build_id: _dropped, ...fields } = record;
    writeFileSync(path, `${JSON.stringify({
        ...fields,
        schema_version: 1,
    })}\n`);

    expect(await createTestLockfile(path).read()).toEqual({
        ...fields,
        schema_version: 1,
    });
});

test("a schema-3 record without a build id is not accepted", async () => {
    const path = temporaryLockPath();
    const record = await createTestLockfile(path).publish();
    writeFileSync(path, `${JSON.stringify({
        ...record,
        build_id: "",
    })}\n`);

    expect(await createTestLockfile(path).read()).toBeUndefined();
});

interface TestLockfileOverrides {
    readonly pid?: number;
    readonly startedAt?: string;
    readonly buildId?: string;
    readonly projectRoot?: string;
    readonly inspectSocket?: () => Promise<{
        readonly pid: number;
        readonly started_at: string;
        readonly protocol_version?: number;
        readonly minimum_compatible_protocol_version?: number;
        readonly build_id?: string;
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
        ...(overrides.buildId === undefined
            ? {}
            : { buildId: overrides.buildId }),
        ...(overrides.projectRoot === undefined
            ? {}
            : { projectRoot: overrides.projectRoot }),
        inspectSocket: overrides.inspectSocket ?? (async () => ({
            pid: overrides.pid ?? 101,
            started_at: overrides.startedAt ?? startedAt,
            protocol_version: HOST_PROTOCOL_VERSION,
        })),
    });
}

function temporaryLockPath(): string {
    const root = mkdtempSync(join("/private/tmp", "vera-host-lock-"));
    temporaryDirectories.push(root);
    return join(root, "host", "host.json");
}
