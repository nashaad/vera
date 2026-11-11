import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostLockfile, readHostLockRecordFile } from "../../src/host/lockfile.ts";
import { checkRecordIdentity, processStartStamp } from "../../src/host/process-identity.ts";

const linux = process.platform === "linux";

// A wall clock that jumped after the record was written, as on WSL2 after Windows resumes.
const jumped = new Date(Date.now() - 3_600_000).toISOString();

test.if(linux)("a start stamp keeps a process identified after the wall clock jumps", () => {
    const stamp = processStartStamp(process.pid);
    expect(stamp).toMatch(/^[0-9a-f-]+:\d+$/);
    expect(checkRecordIdentity({ pid: process.pid, started_at: jumped })).toBe("mismatch");
    expect(checkRecordIdentity({ pid: process.pid, started_at: jumped, start_stamp: stamp! })).toBe("match");
});

test.if(linux)("a different start stamp is another process even when the time matches", () => {
    const now = new Date().toISOString();
    expect(checkRecordIdentity({ pid: process.pid, started_at: now, start_stamp: "other-boot:1" })).toBe("mismatch");
});

test.if(linux)("the host lock records the stamp for its own process and reads it back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-stamp-"));
    try {
        const path = join(directory, "host.json");
        await createHostLockfile({ path, socketPath: join(directory, "host.sock"), buildId: "b" }).publish();
        expect(JSON.parse(readFileSync(path, "utf8")).start_stamp).toBe(processStartStamp(process.pid));
        expect((await readHostLockRecordFile(path))?.start_stamp).toBe(processStartStamp(process.pid));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a fake start time reader keeps the time comparison", () => {
    const record = { pid: process.pid, started_at: jumped, start_stamp: "ignored:1" };
    expect(checkRecordIdentity(record, () => Date.parse(jumped))).toBe("match");
});
