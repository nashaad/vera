import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RestartLedger } from "../../src/host/master/restart-ledger.ts";
import { MAX_RESTART_RECORDS } from "../../src/store/restart-records.ts";

test("concurrent pool record operations preserve order, unknown lines, and the cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-pool-ledger-"));
    const directory = join(root, "restarts");
    const path = join(directory, "restarts.jsonl");
    const at = "2026-11-08T10:00:00.000Z";
    await mkdir(directory);
    const rows = Array.from({ length: MAX_RESTART_RECORDS - 2 }, (_, index) => JSON.stringify({
        format_version: 1, session_id: `crow-${index}`, cause: "stop", at,
    }));
    rows.push(JSON.stringify({ format_version: 2, session_id: "future", cause: "crash", at }), "not json");
    await writeFile(path, `${rows.join("\n")}\n`);
    const ledger = new RestartLedger(path);
    try {
        const written = ledger.append({ session_id: "first", cause: "crash", at });
        const cleared = ledger.clear("first");
        const last = ledger.append({ session_id: "last", cause: "crash", at });
        await written;
        expect(await cleared).toBe(1);
        await last;
        const lines = (await readFile(path, "utf8")).trim().split("\n");
        expect(lines).toHaveLength(MAX_RESTART_RECORDS);
        expect(lines).toContain("not json");
        expect(lines.some((line) => line.includes('"format_version":2'))).toBe(true);
        const records = await ledger.list();
        expect(records.some((record) => record.session_id === "first")).toBe(false);
        expect(records.at(-1)?.session_id).toBe("last");
        expect(records.some((record) => record.session_id === "crow-0")).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed write does not leave later record operations waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-pool-ledger-failure-"));
    const path = join(root, "not-a-file");
    await mkdir(path);
    const ledger = new RestartLedger(path);
    try {
        await expect(ledger.append({ session_id: "crow", cause: "crash", at: "2026-11-08T10:00:00.000Z" })).rejects.toThrow();
        expect(await ledger.list()).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
