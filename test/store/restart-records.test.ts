import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    MAX_RESTART_RECORDS,
    appendRestartRecord,
    clearRestartRecordsForSession,
    defaultRestartRecordPath,
    listRestartRecords,
} from "../../src/store/restart-records.ts";

async function recordPath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vera-restart-records-"));
    return join(root, "runtime", "restarts", "restarts.jsonl");
}

const at = "2026-11-07T10:00:00.000Z";

test("the record path sits under the home's runtime directory", () => {
    const path = defaultRestartRecordPath("/tmp/vera-dev/home");
    expect(path).toBe("/tmp/vera-dev/home/runtime/restarts/restarts.jsonl");
});

test("a record round-trips through the real file with a format version", async () => {
    const path = await recordPath();
    appendRestartRecord(
        { session_id: "crow-1", cause: "update", target_build_id: "b2", at },
        path,
    );
    expect(listRestartRecords(path)).toEqual([
        { session_id: "crow-1", cause: "update", target_build_id: "b2", at },
    ]);
    const line = (await readFile(path, "utf8")).trim();
    expect(JSON.parse(line)).toMatchObject({ format_version: 1, cause: "update" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("a missing file lists nothing and clears nothing", async () => {
    const path = await recordPath();
    expect(listRestartRecords(path)).toEqual([]);
    expect(clearRestartRecordsForSession("crow-1", path)).toBe(0);
});

test("a line with a newer format version is skipped and kept on rewrite", async () => {
    const path = await recordPath();
    appendRestartRecord({ session_id: "crow-1", cause: "stop", at }, path);
    const newer = JSON.stringify({
        format_version: 2,
        session_id: "crow-2",
        cause: "crash",
        at,
    });
    const current = await readFile(path, "utf8");
    await writeFile(path, `${current}${newer}\n`);

    expect(listRestartRecords(path).map((record) => record.session_id))
        .toEqual(["crow-1"]);
    expect(clearRestartRecordsForSession("crow-1", path)).toBe(1);
    expect((await readFile(path, "utf8")).trim()).toBe(newer);
});

test("malformed lines are skipped without failing the read", async () => {
    const path = await recordPath();
    appendRestartRecord({ session_id: "crow-1", cause: "crash", at }, path);
    const current = await readFile(path, "utf8");
    await writeFile(
        path,
        `${current}not json\n{"format_version":1,"session_id":"","cause":"stop","at":"${at}"}\n`
            + `{"format_version":1,"session_id":"x","cause":"exploded","at":"${at}"}\n`,
    );
    expect(listRestartRecords(path).map((record) => record.session_id))
        .toEqual(["crow-1"]);
});

test("a path that is a directory reads as empty instead of crashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-restart-dir-"));
    expect(listRestartRecords(root)).toEqual([]);
});

test("clearing by session id removes only that session's records", async () => {
    const path = await recordPath();
    appendRestartRecord({ session_id: "crow-1", cause: "stop", at }, path);
    appendRestartRecord({ session_id: "crow-2", cause: "update", at }, path);
    appendRestartRecord({ session_id: "crow-1", cause: "crash", at }, path);

    expect(clearRestartRecordsForSession("crow-1", path)).toBe(2);
    expect(listRestartRecords(path).map((record) => record.session_id))
        .toEqual(["crow-2"]);
});

test("the file holds at most 500 records and drops the oldest", async () => {
    const path = await recordPath();
    for (let index = 0; index < MAX_RESTART_RECORDS + 3; index += 1) {
        appendRestartRecord({ session_id: `crow-${index}`, cause: "stop", at }, path);
    }
    const records = listRestartRecords(path);
    expect(records.length).toBe(MAX_RESTART_RECORDS);
    expect(records[0]?.session_id).toBe("crow-3");
    expect(records.at(-1)?.session_id).toBe(`crow-${MAX_RESTART_RECORDS + 2}`);
});
