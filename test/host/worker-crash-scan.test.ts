import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverCrashSession } from "../../src/host/pool/worker-crash-scan.ts";

test("crash-session discovery reads long headers and rejects a header without a newline inside the cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "crash-header-"));
    const long = join(root, "long.jsonl");
    const tooLong = join(root, "too-long.jsonl");
    try {
        await writeFile(long, `${JSON.stringify({ type: "session", id: "crow", padding: "x".repeat(9_000) })}\n`);
        await writeFile(tooLong, `${JSON.stringify({ type: "session", id: "crow", padding: "x".repeat(64 * 1_024) })}\n`);
        expect(await discoverCrashSession(long)).toEqual({ path: long, id: "crow" });
        expect(await discoverCrashSession(tooLong)).toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
