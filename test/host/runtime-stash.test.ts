import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { readStashRecord, restoreRuntimeStash, runtimeStashesDirectory, stashRuntime } from "../../src/host/runtime-stash.ts";
import { parseBootAnswer } from "../../clients/cli/main.ts";

test("a stash moves the runtime aside, carries durable state over, and rolls back exactly", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-stash-"));
    try {
        const runtime = join(home, "runtime");
        mkdirSync(join(runtime, "blocked"), { recursive: true });
        writeFileSync(join(runtime, "host.json"), "{}");
        writeFileSync(join(runtime, "blocked", "s1"), "blocked");
        const inbox = new Database(join(runtime, "inbox.db"));
        inbox.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
        inbox.close();

        const stash = stashRuntime(home, { reason: "test", unknown_processes: ["PID 1: x"] });
        expect(stash.notCarried).toEqual([]);
        expect(existsSync(join(runtime, "host.json"))).toBe(false);
        expect(existsSync(join(runtime, "blocked", "s1"))).toBe(true);
        const copy = new Database(join(runtime, "inbox.db"), { readonly: true });
        expect(copy.query("SELECT v FROM t").get()).toEqual({ v: "kept" });
        copy.close();
        expect(existsSync(join(stash.path, "host.json"))).toBe(true);
        expect(readStashRecord(stash.path)?.unknown_processes).toEqual(["PID 1: x"]);

        writeFileSync(join(runtime, "fresh.txt"), "fresh");
        restoreRuntimeStash(home, stash.path);
        expect(existsSync(join(runtime, "host.json"))).toBe(true);
        expect(existsSync(join(runtime, "STASH.json"))).toBe(false);
        expect(existsSync(stash.path)).toBe(false);
        const kept = readdirSync(runtimeStashesDirectory(home));
        expect(kept.some((name) => name.startsWith("discarded-"))).toBe(true);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("a folder without a stash record is never restored", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-stash-"));
    try {
        mkdirSync(join(home, "other"));
        expect(() => restoreRuntimeStash(home, join(home, "other"))).toThrow("is not a Vera runtime stash");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("a GUI answer reads yes, no, JSON, or a closed stdin as yes", () => {
    expect(parseBootAnswer("no")).toBe(false);
    expect(parseBootAnswer("N")).toBe(false);
    expect(parseBootAnswer("yes")).toBe(true);
    expect(parseBootAnswer("{\"answer\":false}")).toBe(false);
    expect(parseBootAnswer("true")).toBe(true);
    expect(parseBootAnswer(undefined)).toBe(true);
});
