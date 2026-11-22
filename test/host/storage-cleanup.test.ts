import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    previewStorageCleanup,
    runStorageCleanup,
    type StorageCleanupOptions,
} from "../../src/host/storage-cleanup.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
    readonly home: string;
    readonly sessions: string;
    readonly scratch: string;
    readonly logs: string;
    readonly temp: string;
    readonly options: (live: Set<string>, keptLogs?: Set<string>) => StorageCleanupOptions;
}

function fixture(): Fixture {
    const home = mkdtempSync(join(tmpdir(), "vera-storage-cleanup-"));
    const sessions = join(home, "runtime", "sessions");
    const scratch = join(home, "runtime", "scratch");
    const logs = join(home, "runtime", "logs");
    const temp = mkdtempSync(join(tmpdir(), "vera-storage-cleanup-temp-"));
    mkdirSync(sessions, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(logs, "workspace"), { recursive: true });
    return {
        home,
        sessions,
        scratch,
        logs,
        temp,
        options: (live, keptLogs = new Set()) => ({
            sessionDirectory: sessions,
            scratchDirectory: scratch,
            logDirectory: logs,
            tempRoot: temp,
            now: new Date(),
            removeIfUnowned: async (id, detach) => live.has(id) ? false : detach(() => true),
            keepLog: (path) => keptLogs.has(path),
        }),
    };
}

async function oldSession(sessions: string, id: string, ageDays: number): Promise<string> {
    const path = join(sessions, `${id}.jsonl`);
    await SessionStore.create(path, { sessionId: id, cwd: join(sessions, "..") });
    const old = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(path, old, old);
    return path;
}

function oldFolder(path: string, ageDays: number): void {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "payload"), "x".repeat(2048));
    const old = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(join(path, "payload"), old, old);
    utimesSync(path, old, old);
}

function cleanup(fixture: Fixture): void {
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(fixture.temp, { recursive: true, force: true });
}

test("@core cleanup honours the age, previews before deleting, and reports freed bytes", async () => {
    const f = fixture();
    try {
        await oldSession(f.sessions, "idle", 10);
        oldFolder(join(f.scratch, "idle"), 10);
        await oldSession(f.sessions, "recent", 1);
        oldFolder(join(f.scratch, "recent"), 10);
        const options = f.options(new Set());
        const seven = await previewStorageCleanup("scratch", 7, options);
        expect(seven.count).toBe(1);
        expect(seven.names).toEqual(["idle"]);
        expect(seven.bytes).toBeGreaterThan(0);
        expect((await previewStorageCleanup("scratch", 30, options)).count).toBe(0);
        expect(existsSync(join(f.scratch, "idle"))).toBe(true);
        const result = await runStorageCleanup("scratch", 7, options);
        expect(result.removed).toBe(1);
        expect(result.removed_bytes).toBe(seven.bytes);
        expect(existsSync(join(f.scratch, "idle"))).toBe(false);
        expect(existsSync(join(f.scratch, "recent"))).toBe(true);
        expect(existsSync(join(f.sessions, "idle.jsonl"))).toBe(true);
    } finally {
        cleanup(f);
    }
});

test("@core cleanup keeps a live session's scratch and rechecks liveness before deleting", async () => {
    const f = fixture();
    try {
        await oldSession(f.sessions, "live", 10);
        oldFolder(join(f.scratch, "live"), 10);
        await oldSession(f.sessions, "turns-live", 10);
        oldFolder(join(f.scratch, "turns-live"), 10);
        const live = new Set<string>();
        const options = f.options(live);
        live.add("live");
        const preview = await previewStorageCleanup("scratch", 7, options);
        expect(preview.names).toEqual(["turns-live"]);
        live.add("turns-live");
        const result = await runStorageCleanup("scratch", 7, options);
        expect(result.removed).toBe(0);
        expect(existsSync(join(f.scratch, "live"))).toBe(true);
        expect(existsSync(join(f.scratch, "turns-live"))).toBe(true);
        expect(existsSync(join(f.sessions, "turns-live.jsonl"))).toBe(true);
    } finally {
        cleanup(f);
    }
});

test("@core cleanup keeps a log the running host or a live session writes", async () => {
    const f = fixture();
    try {
        const liveLog = join(f.logs, "workspace", "live.jsonl");
        const deadLog = join(f.logs, "workspace", "dead.jsonl");
        writeFileSync(liveLog, "live log");
        writeFileSync(deadLog, "dead log");
        const old = new Date(Date.now() - 10 * DAY_MS);
        utimesSync(liveLog, old, old);
        utimesSync(deadLog, old, old);
        const options = f.options(new Set(), new Set([liveLog]));
        const preview = await previewStorageCleanup("logs", 7, options);
        expect(preview.count).toBe(1);
        expect(preview.names).toEqual(["workspace/dead.jsonl"]);
        const result = await runStorageCleanup("logs", 7, options);
        expect(result.removed).toBe(1);
        expect(existsSync(liveLog)).toBe(true);
        expect(existsSync(deadLog)).toBe(false);
    } finally {
        cleanup(f);
    }
});

test("@core cleanup removes only old scratch that belongs to a session in this home", async () => {
    const f = fixture();
    try {
        await oldSession(f.sessions, "belongs", 10);
        oldFolder(join(f.temp, "belongs"), 10);
        oldFolder(join(f.temp, "not-a-session"), 10);
        const live = new Set<string>();
        const preview = await previewStorageCleanup("old_scratch", 7, f.options(live));
        expect(preview.count).toBe(1);
        expect(preview.names).toEqual(["belongs"]);
        live.add("belongs");
        const kept = await runStorageCleanup("old_scratch", 7, f.options(live));
        expect(kept.removed).toBe(0);
        expect(existsSync(join(f.temp, "belongs"))).toBe(true);
        live.delete("belongs");
        const removed = await runStorageCleanup("old_scratch", 7, f.options(live));
        expect(removed.removed).toBe(1);
        expect(removed.removed_bytes).toBe(preview.bytes);
        expect(existsSync(join(f.temp, "belongs"))).toBe(false);
        expect(existsSync(join(f.temp, "not-a-session"))).toBe(true);
        expect(existsSync(join(f.sessions, "belongs.jsonl"))).toBe(true);
    } finally {
        cleanup(f);
    }
});

test("@core cleanup never removes session files, attachments or settings", async () => {
    const f = fixture();
    try {
        const session = await oldSession(f.sessions, "kept", 10);
        const attachment = `${session}.attachments`;
        writeFileSync(attachment, "attachment");
        const old = new Date(Date.now() - 10 * DAY_MS);
        utimesSync(attachment, old, old);
        oldFolder(join(f.scratch, "kept"), 10);
        oldFolder(join(f.temp, "kept"), 10);
        const log = join(f.logs, "workspace", "kept.jsonl");
        writeFileSync(log, "log");
        utimesSync(log, old, old);
        const options = f.options(new Set());
        for (const area of ["scratch", "logs", "old_scratch"] as const) {
            await runStorageCleanup(area, 7, options);
        }
        expect(existsSync(session)).toBe(true);
        expect(existsSync(attachment)).toBe(true);
        expect(existsSync(log)).toBe(false);
    } finally {
        cleanup(f);
    }
});
