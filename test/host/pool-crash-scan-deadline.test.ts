import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { recoverPoolCrashedTurns } from "../../src/host/pool/crash-scan.ts";
import { RestartLedger } from "../../src/host/pool/restart-ledger.ts";

test("the crash scan deadline includes candidate enumeration", async () => {
    await fs.mkdir("/tmp/vera-dev", { recursive: true });
    const home = await fs.mkdtemp(join(await fs.realpath("/tmp/vera-dev"), "pd-deadline-"));
    const directory = join(home, "runtime", "sessions");
    await fs.mkdir(directory, { recursive: true });
    const lockPath = join(home, "runtime", "host.json");
    await fs.writeFile(lockPath, JSON.stringify({
        schema_version: 3, pid: 2_147_483_646, started_at: new Date(Date.now() - 60_000).toISOString(),
        socket_path: join(home, "runtime", "host.sock"), build_id: "crashed-build",
    }));
    const listing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = fs.readdir;
    const probe = spyOn(fs, "readdir").mockImplementation((async (path: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(path) === directory) {
            listing.resolve();
            await release.promise;
        }
        return await Reflect.apply(original, fs, [path, ...args]);
    }) as typeof fs.readdir);
    try {
        const scan = recoverPoolCrashedTurns({
            lockPath, sessionDirectory: directory, recordPath: join(home, "runtime", "restart-records.json"),
            workers: [], owner: () => "w0", ledger: new RestartLedger(join(home, "runtime", "restart-records.json")),
            setRecorder: () => {}, timeoutMs: 100,
        });
        void scan.catch(() => {});
        await listing.promise;
        await expect(scan).rejects.toThrow("Session crash scan exceeded its deadline.");
    } finally {
        release.resolve();
        probe.mockRestore();
        await fs.rm(home, { recursive: true, force: true });
    }
});
