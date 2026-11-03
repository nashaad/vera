import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pairedHostSocket, refuseOtherHostBuild } from "../../clients/tui/configured-agent-client.ts";
import { readHostLockRecordFile, type HostLockRecord } from "../../src/host/lockfile.ts";
import { HostBuildChangedError } from "../../src/host/reconnecting-agent-client.ts";

test("Reconnect host refuses a live host of another build before discovery runs", async () => {
    const refused = await refuseOtherHostBuild("vera-crow-1", async () => "vera-kraken-2").catch((error) => error);
    expect(refused).toBeInstanceOf(HostBuildChangedError);
    expect(refused).toMatchObject({ clientBuildId: "vera-crow-1", hostBuildId: "vera-kraken-2" });
});

test("Reconnect host goes ahead when the live host is this build or there is no live host", async () => {
    await refuseOtherHostBuild("vera-crow-1", async () => "vera-crow-1");
    await refuseOtherHostBuild("vera-crow-1", async () => undefined);
});

const crowHost: HostLockRecord = {
    schema_version: 3,
    pid: 4242,
    started_at: "2026-11-03T00:00:00.000Z",
    socket_path: "/tmp/crow/host.sock",
    build_id: "vera-crow-1",
};

test("a request refuses the socket when the lockfile names another build on it", async () => {
    const refused = await pairedHostSocket(
        crowHost.socket_path,
        "vera-crow-1",
        async () => ({ ...crowHost, build_id: "vera-kraken-2" }),
    ).catch((error) => error);
    expect(refused).toBeInstanceOf(HostBuildChangedError);
    expect(refused).toMatchObject({ clientBuildId: "vera-crow-1", hostBuildId: "vera-kraken-2" });
});

test("a request keeps its socket for this build, no lockfile, another socket, or no build ID", async () => {
    const { build_id: _unused, ...unstamped } = crowHost;
    const cases: readonly (HostLockRecord | undefined)[] = [
        crowHost,
        undefined,
        { ...crowHost, socket_path: "/tmp/kraken/host.sock", build_id: "vera-kraken-2" },
        { ...unstamped, schema_version: 2 },
    ];
    for (const record of cases) {
        expect(await pairedHostSocket(crowHost.socket_path, "vera-crow-1", async () => record))
            .toBe(crowHost.socket_path);
    }
});

test("a request reads the build from the lockfile on disk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-paired-"));
    try {
        const lockPath = join(directory, "host.json");
        writeFileSync(lockPath, JSON.stringify({ ...crowHost, build_id: "vera-kraken-2" }));
        const refused = await pairedHostSocket(
            crowHost.socket_path,
            "vera-crow-1",
            () => readHostLockRecordFile(lockPath),
        ).catch((error) => error);
        expect(refused).toBeInstanceOf(HostBuildChangedError);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
