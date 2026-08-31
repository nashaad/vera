import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ensureResidentHost } from "../../src/host/discovery.ts";
import {
    assertMatchingHostBuild,
    createHostLockfile,
    HostBuildMismatchError,
    type HostLockRecord,
} from "../../src/host/lockfile.ts";
import {
    HOST_PROTOCOL_VERSION,
    requestHostIdentity,
} from "../../src/host/protocol.ts";
import { startHostServer } from "../../src/host/server.ts";
import { thisProcessBuildId } from "../../src/release/stamp.ts";
import { renderCliFailure } from "../../clients/cli/main.ts";

const startedAt = "2026-08-31T12:00:00.000Z";

test("a build mismatch names both IDs and the host-stop command", () => {
    expect(() =>
        assertMatchingHostBuild({ build_id: "vera-host-b" }, "vera-client-c")
    ).toThrow(HostBuildMismatchError);
    try {
        assertMatchingHostBuild({ build_id: "vera-host-b" }, "vera-client-c");
    } catch (error) {
        expect(error).toBeInstanceOf(HostBuildMismatchError);
        expect((error as HostBuildMismatchError).message).toContain(
            "vera-client-c",
        );
        expect((error as HostBuildMismatchError).message).toContain(
            "vera-host-b",
        );
        expect((error as HostBuildMismatchError).message).toContain(
            "vera host stop",
        );
        expect(renderCliFailure(error)).toContain("vera-client-c");
        expect(renderCliFailure(error)).toContain("vera-host-b");
        expect(renderCliFailure(error)).toContain("vera host stop");
    }
});

test("a matching build is reused", async () => {
    const running: HostLockRecord = {
        schema_version: 3,
        pid: 101,
        started_at: startedAt,
        socket_path: "/tmp/vera-host.sock",
        build_id: thisProcessBuildId(),
    };
    let starts = 0;
    const host = await ensureResidentHost({
        lockfile: {
            publish(): Promise<HostLockRecord> {
                throw new Error("not used");
            },
            read: async () => running,
        },
        startHost: () => {
            starts += 1;
        },
    });
    expect(host).toEqual(running);
    expect(starts).toBe(0);
});

test("the same protocol with a different build ID is refused", async () => {
    const path = temporaryLockPath();
    const lockfile = createHostLockfile({
        path,
        socketPath: "/tmp/vera-test.sock",
        pid: 101,
        startedAt,
        buildId: "vera-host-b",
        inspectSocket: async () => ({
            pid: 101,
            started_at: startedAt,
            protocol_version: HOST_PROTOCOL_VERSION,
            build_id: "vera-host-b",
        }),
    });
    await lockfile.publish();
    let starts = 0;
    try {
        await ensureResidentHost({
            lockfile,
            startHost: () => {
                starts += 1;
            },
        });
        throw new Error("expected a build mismatch");
    } catch (error) {
        expect(error).toBeInstanceOf(HostBuildMismatchError);
        expect((error as HostBuildMismatchError).message).toContain(
            thisProcessBuildId(),
        );
        expect((error as HostBuildMismatchError).message).toContain(
            "vera-host-b",
        );
        expect((error as HostBuildMismatchError).message).toContain(
            "vera host stop",
        );
    }
    expect(starts).toBe(0);
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the host identity handshake reports this process's stamped build ID",
    async () => {
        const directory = mkdtempSync(join("/private/tmp", "vera-build-id-"));
        const socketPath = join(directory, "host.sock");
        const server = await startHostServer({
            socketPath,
            lockPath: join(directory, "host.json"),
        });
        try {
            const identity = await requestHostIdentity(socketPath);
            expect(identity?.build_id).toBe(thisProcessBuildId());
            expect(identity?.protocol_version).toBe(HOST_PROTOCOL_VERSION);
            expect(server.lock.build_id).toBe(thisProcessBuildId());
        } finally {
            await server.close();
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

function temporaryLockPath(): string {
    const root = mkdtempSync(join("/private/tmp", "vera-build-pair-"));
    return join(root, "host", "host.json");
}
