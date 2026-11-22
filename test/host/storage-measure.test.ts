import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorageMeasurer } from "../../src/host/storage-measure.ts";
import type { StorageMeasurement } from "../../src/host/storage-protocol.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
    readonly home: string;
    readonly sessions: string;
    readonly scratch: string;
    readonly logs: string;
    readonly temp: string;
}

async function fixture(): Promise<Fixture> {
    const home = mkdtempSync(join(tmpdir(), "vera-storage-measure-"));
    const sessions = join(home, "runtime", "sessions");
    const scratch = join(home, "runtime", "scratch");
    const logs = join(home, "runtime", "logs");
    const temp = mkdtempSync(join(tmpdir(), "vera-storage-temp-"));
    mkdirSync(sessions, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    mkdirSync(logs, { recursive: true });
    await SessionStore.create(join(sessions, "session-a.jsonl"), { sessionId: "session-a", cwd: home });
    const store = await SessionStore.open(join(sessions, "session-a.jsonl"));
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Plan the launch" }] });
    writeFileSync(join(sessions, "session-a.jsonl.attachments"), "attachment bytes");
    mkdirSync(join(scratch, "session-a"), { recursive: true });
    writeFileSync(join(scratch, "session-a", "note.txt"), "scratch bytes");
    writeFileSync(join(logs, "session-a.jsonl"), "log bytes");
    mkdirSync(join(home, "runtime", "cache"), { recursive: true });
    writeFileSync(join(home, "runtime", "cache", "cache.bin"), "cache bytes");
    mkdirSync(join(home, "machine", "cache"), { recursive: true });
    writeFileSync(join(home, "machine", "cache", "machine.bin"), "machine bytes");
    mkdirSync(join(home, "machine", "desktop", "chromium", "Default"), { recursive: true });
    writeFileSync(join(home, "machine", "desktop", "chromium", "Default", "data"), "browser bytes");
    mkdirSync(join(home, "extensions", "ext-one"), { recursive: true });
    writeFileSync(join(home, "extensions", "ext-one", "main.js"), "extension bytes");
    mkdirSync(join(home, "extension-data", "ext-one"), { recursive: true });
    writeFileSync(join(home, "extension-data", "ext-one", "data.json"), "extension data");
    mkdirSync(join(home, "skills", "skill-one"), { recursive: true });
    writeFileSync(join(home, "skills", "skill-one", "SKILL.md"), "skill bytes");
    mkdirSync(join(home, "agents", "agent-one"), { recursive: true });
    writeFileSync(join(home, "agents", "agent-one", "agent.md"), "agent bytes");
    mkdirSync(join(home, "memory"));
    writeFileSync(join(home, "memory", "memory-one.md"), "memory bytes");
    writeFileSync(join(home, "runtime", "inbox.db"), "inbox bytes");
    writeFileSync(join(home, "runtime", "schedules.db"), "schedules bytes");
    writeFileSync(join(home, "notes.txt"), "other bytes");
    writeFileSync(join(home, "machine", "desktop", "layout.json"), "layout bytes");
    mkdirSync(join(temp, "session-a"), { recursive: true });
    writeFileSync(join(temp, "session-a", "old.txt"), "old scratch bytes");
    mkdirSync(join(temp, "not-a-session"), { recursive: true });
    writeFileSync(join(temp, "not-a-session", "big.txt"), Buffer.alloc(4096, 2));
    return { home, sessions, scratch, logs, temp };
}

function category(measurement: StorageMeasurement, name: string) {
    const found = measurement.categories.find((entry) => entry.category === name);
    if (found === undefined) throw new Error(`missing category ${name}`);
    return found;
}

test("@core storage measures every home category, titles sessions, and keeps old scratch apart", async () => {
    const { home, sessions, scratch, logs, temp } = await fixture();
    try {
        const measure = createStorageMeasurer({
            home,
            sessionDirectory: sessions,
            logDirectory: logs,
            scratchDirectory: scratch,
            tempRoot: temp,
            now: () => new Date("2026-11-22T12:00:00.000Z"),
        });
        const measurement = await measure.measure(false);
        expect(measurement.measured_at).toBe("2026-11-22T12:00:00.000Z");
        expect(measurement.partial).toBe(false);
        expect(measurement.categories.map((entry) => entry.category)).toEqual([
            "sessions", "scratch", "logs", "caches", "extensions", "browser", "other",
        ]);
        expect(category(measurement, "sessions").summary).toBe("1 session and 2 databases");
        expect(category(measurement, "sessions").largest[0]?.name).toBe("Plan the launch");
        expect(category(measurement, "scratch").summary).toBe("1 session folder");
        expect(category(measurement, "scratch").largest[0]?.name).toBe("Plan the launch");
        expect(category(measurement, "logs").summary).toBe("1 log file");
        expect(category(measurement, "extensions").summary).toBe("5 files");
        expect(category(measurement, "other").summary).toBe("2 other files");
        expect(category(measurement, "other").largest.map((item) => item.name).sort())
            .toEqual(["desktop", "notes.txt"]);
        const expected: Record<string, readonly string[]> = {
            sessions: [
                ...readdirSync(sessions).map((name) => join(sessions, name)),
                join(home, "runtime", "inbox.db"),
                join(home, "runtime", "schedules.db"),
            ],
            scratch: [join(scratch, "session-a", "note.txt")],
            logs: [join(logs, "session-a.jsonl")],
            caches: [
                join(home, "runtime", "cache", "cache.bin"),
                join(home, "machine", "cache", "machine.bin"),
            ],
            extensions: [
                join(home, "extensions", "ext-one", "main.js"),
                join(home, "extension-data", "ext-one", "data.json"),
                join(home, "skills", "skill-one", "SKILL.md"),
                join(home, "agents", "agent-one", "agent.md"),
                join(home, "memory", "memory-one.md"),
            ],
            browser: [join(home, "machine", "desktop", "chromium", "Default", "data")],
            other: [join(home, "notes.txt"), join(home, "machine", "desktop", "layout.json")],
        };
        for (const [name, paths] of Object.entries(expected)) {
            const bytes = paths.reduce((sum, path) => sum + statSync(path).size, 0);
            expect(category(measurement, name).bytes).toBe(bytes);
        }
        expect(measurement.total_bytes)
            .toBe(measurement.categories.reduce((sum, entry) => sum + entry.bytes, 0));
        expect(measurement.old_scratch.category).toBe("old_scratch");
        expect(measurement.old_scratch.summary).toBe("1 temporary session folder");
        expect(measurement.old_scratch.items).toBe(1);
        expect(measurement.old_scratch.largest[0]?.name).toBe("Plan the launch");
        expect(measurement.old_scratch.bytes).toBe(statSync(join(temp, "session-a", "old.txt")).size);
        expect(measurement.categories.some((entry) => entry.category === "old_scratch")).toBe(false);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
    }
});

test("@core storage reuses the last scan unless refresh is true and shares one running scan", async () => {
    const { home, sessions, scratch, logs, temp } = await fixture();
    try {
        let now = new Date("2026-11-22T12:00:00.000Z");
        const measure = createStorageMeasurer({
            home,
            sessionDirectory: sessions,
            logDirectory: logs,
            scratchDirectory: scratch,
            tempRoot: temp,
            now: () => now,
        });
        const first = await measure.measure(false);
        now = new Date("2026-11-22T12:01:00.000Z");
        writeFileSync(join(home, "notes.txt"), "a much larger other file");
        const cached = await measure.measure(false);
        expect(cached).toBe(first);
        const runningA = measure.measure(true);
        const runningB = measure.measure(true);
        expect(runningA).toBe(runningB);
        const refreshed = await runningA;
        expect(refreshed).not.toBe(first);
        expect(refreshed.measured_at).toBe("2026-11-22T12:01:00.000Z");
        expect(category(refreshed, "other").bytes).toBeGreaterThan(category(first, "other").bytes);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
    }
});

test("@core storage counts a symlink as one item and never follows it", async () => {
    const { home, sessions, scratch, logs, temp } = await fixture();
    const outside = mkdtempSync(join(tmpdir(), "vera-storage-outside-"));
    try {
        writeFileSync(join(outside, "big.bin"), Buffer.alloc(5_000_000, 1));
        const measure = createStorageMeasurer({
            home,
            sessionDirectory: sessions,
            logDirectory: logs,
            scratchDirectory: scratch,
            tempRoot: temp,
        });
        const before = await measure.measure(true);
        symlinkSync(join(outside, "big.bin"), join(home, "link-to-big"));
        const after = await measure.measure(true);
        expect(after.total_bytes).toBe(before.total_bytes);
        expect(after.total_bytes).toBeLessThan(5_000_000);
        expect(category(after, "other").items).toBe(category(before, "other").items + 1);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    }
});

test("@core storage marks a scan that stopped at the entry cap as partial", async () => {
    const { home, sessions, scratch, logs, temp } = await fixture();
    const old = new Date(Date.now() - 2 * DAY_MS);
    utimesSync(join(home, "notes.txt"), old, old);
    try {
        const measure = createStorageMeasurer({
            home,
            sessionDirectory: sessions,
            logDirectory: logs,
            scratchDirectory: scratch,
            tempRoot: temp,
            entryLimit: 3,
        });
        const measurement = await measure.measure(false);
        expect(measurement.partial).toBe(true);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
    }
});
