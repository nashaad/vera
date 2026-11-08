import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defaultHostLockPath } from "../../src/host/lockfile.ts";
import { processStartedAt } from "../../src/host/process-identity.ts";
import { defaultReadLiveHost } from "../../src/release/handoff.ts";

async function withLockRecord(
    record: { pid: number; started_at: string; build_id: string },
    body: () => Promise<void>,
): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "vera-live-host-"));
    const previous = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        const lockPath = defaultHostLockPath();
        await mkdir(dirname(lockPath), { recursive: true });
        await writeFile(lockPath, JSON.stringify({
            schema_version: 3,
            socket_path: join(home, "runtime", "host.sock"),
            ...record,
        }));
        await body();
    } finally {
        if (previous === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previous;
        await rm(home, { recursive: true, force: true });
    }
}

test("defaultReadLiveHost returns a lock whose pid runs and matches its start time", async () => {
    await withLockRecord({
        pid: process.pid,
        started_at: new Date(processStartedAt(process.pid) ?? 0).toISOString(),
        build_id: "vera-live",
    }, async () => {
        const live = await defaultReadLiveHost();
        expect(live?.build_id).toBe("vera-live");
    });
});

test("defaultReadLiveHost ignores a lock whose pid now belongs to another process", async () => {
    await withLockRecord({
        pid: process.pid,
        started_at: "2001-01-01T00:00:00.000Z",
        build_id: "vera-reused",
    }, async () => {
        expect(await defaultReadLiveHost()).toBeUndefined();
    });
});
