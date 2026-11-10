import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureResidentHost } from "../../src/host/discovery.ts";
import { unverifiedHostMessage } from "../../src/host/force-stop.ts";
import { createHostLockfile } from "../../src/host/lockfile.ts";
import { checkRecordIdentity } from "../../src/host/process-identity.ts";

test("older-host replacement does not signal a reused pid", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs9-identity-"));
    const path = join(home, "host.json");
    const socketPath = join(home, "host.sock");
    const record = {
        schema_version: 3 as const,
        pid: process.pid,
        started_at: "2000-01-01T00:00:00.000Z",
        socket_path: socketPath,
        build_id: "test-build",
    };
    const signals: Array<{ pid: number; signal: string | number | undefined }> = [];
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
        signals.push({ pid, signal });
        throw new Error("unexpected signal");
    });
    try {
        await writeFile(path, JSON.stringify(record));
        expect(checkRecordIdentity(record)).toBe("mismatch");
        const lockfile = createHostLockfile({
            path,
            socketPath,
            inspectSocket: async () => ({
                pid: record.pid,
                started_at: record.started_at,
                protocol_version: 1,
            }),
        });
        await expect(ensureResidentHost({
            lockfile,
            startHost: () => { throw new Error("must not start"); },
            shutdownForReplacement: async () => undefined,
            shutdownIfIdle: async () => ({ type: "shutdown_if_idle_refused", reason: "busy" }),
            confirmBusyUpgrade: () => true,
        })).rejects.toThrow(unverifiedHostMessage(record));
        expect(signals).toEqual([]);
    } finally {
        kill.mockRestore();
        await rm(home, { recursive: true, force: true });
    }
});
