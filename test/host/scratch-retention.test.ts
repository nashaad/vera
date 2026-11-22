import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLiveVeraConfigReader, loadVeraConfig, VeraConfigError } from "../../src/config.ts";
import { DEFAULT_SCRATCH_MAX_AGE_MS, pruneScratch, scratchMaxAgeMs, type GuardedScratchDetach } from "../../src/host/scratch-retention.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

test("@core scratch retention removes orphans and old idle directories only", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-retention-"));
    const scratch = join(root, "runtime", "scratch");
    const sessions = join(root, "runtime", "sessions");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const old = new Date(Date.now() - 6 * DAY_MS);
    for (const id of ["orphan", "old", "recent", "live"]) {
        mkdirSync(join(scratch, id));
        utimesSync(join(scratch, id), old, old);
        if (id !== "orphan") {
            await SessionStore.create(join(sessions, `${id}.jsonl`), { sessionId: id, cwd: root });
            utimesSync(join(sessions, `${id}.jsonl`), old, old);
        }
    }
    const recent = new Date();
    utimesSync(join(sessions, "recent.jsonl"), recent, recent);
    const removed: string[] = [];
    try {
        const result = await pruneScratch(scratch, sessions, {
            now: new Date(),
            maxAgeMs: 4 * DAY_MS,
            removeIfUnowned: async (id, detach) => {
                if (id === "live") return false;
                const detached = await detach(() => true);
                if (detached) removed.push(id);
                return detached;
            },
        });
        expect(result.removedDirectories).toBe(2);
        expect(removed.sort()).toEqual(["old", "orphan"]);
        for (const id of ["old", "recent", "live"]) {
            expect(existsSync(join(sessions, `${id}.jsonl`))).toBe(true);
        }
        expect(existsSync(join(scratch, "recent"))).toBe(true);
        expect(existsSync(join(scratch, "live"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core scratch retention uses the session file mtime regardless of scratch mtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-mtime-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    mkdirSync(join(scratch, "session"), { recursive: true });
    mkdirSync(sessions);
    await SessionStore.create(join(sessions, "session.jsonl"), { sessionId: "session", cwd: root });
    const old = new Date(Date.now() - 6 * DAY_MS);
    utimesSync(join(scratch, "session"), old, old);
    utimesSync(join(sessions, "session.jsonl"), old, old);
    const recent = new Date();
    utimesSync(join(scratch, "session"), recent, recent);
    try {
        const result = await pruneScratch(scratch, sessions, {
            maxAgeMs: 4 * DAY_MS,
            removeIfUnowned: (_id, detach) => detach(() => true),
        });
        expect(result.removedDirectories).toBe(1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core scratch retention rechecks session activity inside the ownership guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-recheck-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    mkdirSync(join(scratch, "old"), { recursive: true });
    mkdirSync(join(scratch, "new"));
    mkdirSync(sessions);
    const oldPath = join(sessions, "old.jsonl");
    await SessionStore.create(oldPath, { sessionId: "old", cwd: root });
    const old = new Date(Date.now() - 6 * DAY_MS);
    utimesSync(oldPath, old, old);
    utimesSync(join(scratch, "new"), old, old);
    try {
        const result = await pruneScratch(scratch, sessions, {
            maxAgeMs: 4 * DAY_MS,
            removeIfUnowned: async (id, detach) => {
                if (id === "old") {
                    const now = new Date();
                    utimesSync(oldPath, now, now);
                } else {
                    await SessionStore.create(join(sessions, `${id}.jsonl`), { sessionId: id, cwd: root });
                }
                return await detach(() => true);
            },
        });
        expect(result.removedDirectories).toBe(0);
        expect(existsSync(join(scratch, "old"))).toBe(true);
        expect(existsSync(join(scratch, "new"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a stopped scratch sweep cannot remove after the ownership guard returns", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-stop-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    mkdirSync(join(scratch, "orphan"), { recursive: true });
    mkdirSync(sessions);
    const old = new Date(Date.now() - 6 * DAY_MS);
    utimesSync(join(scratch, "orphan"), old, old);
    let stopped = false;
    try {
        const result = await pruneScratch(scratch, sessions, {
            isStopped: () => stopped,
            removeIfUnowned: async (_id, detach) => {
                stopped = true;
                return await detach(() => true);
            },
        });
        expect(result.removedDirectories).toBe(0);
        expect(existsSync(join(scratch, "orphan"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core apparent orphans use the newest direct-entry or folder mtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-orphan-age-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    const old = new Date(Date.now() - 6 * DAY_MS);
    mkdirSync(sessions, { recursive: true });
    for (const id of ["old", "recent-entry", "recent-folder", "nested"]) {
        mkdirSync(join(scratch, id), { recursive: true });
    }
    writeFileSync(join(scratch, "old", "note"), "old");
    writeFileSync(join(scratch, "recent-entry", "note"), "recent");
    mkdirSync(join(scratch, "nested", "spill"));
    writeFileSync(join(scratch, "nested", "spill", "part"), "recent but nested");
    for (const path of [
        join(scratch, "old", "note"), join(scratch, "nested", "spill"),
        join(scratch, "old"), join(scratch, "recent-entry"), join(scratch, "nested"),
    ]) utimesSync(path, old, old);
    try {
        const result = await pruneScratch(scratch, sessions, {
            removeIfUnowned: (_id, detach) => detach(() => true),
        });
        expect(result.removedDirectories).toBe(2);
        expect(existsSync(join(scratch, "old"))).toBe(false);
        expect(existsSync(join(scratch, "nested"))).toBe(false);
        expect(existsSync(join(scratch, "recent-entry", "note"))).toBe(true);
        expect(existsSync(join(scratch, "recent-folder"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core apparent orphan activity is rechecked inside the ownership guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-orphan-recheck-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    const folder = join(scratch, "orphan");
    mkdirSync(folder, { recursive: true });
    mkdirSync(sessions);
    const note = join(folder, "note");
    writeFileSync(note, "old");
    const old = new Date(Date.now() - 6 * DAY_MS);
    utimesSync(note, old, old);
    utimesSync(folder, old, old);
    try {
        const result = await pruneScratch(scratch, sessions, {
            removeIfUnowned: async (_id, detach) => {
                const now = new Date();
                utimesSync(note, now, now);
                return await detach(() => true);
            },
        });
        expect(result.removedDirectories).toBe(0);
        expect(existsSync(note)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core scratch is detached under the guard and removed asynchronously after it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-detach-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    const folder = join(scratch, "old");
    mkdirSync(folder, { recursive: true });
    mkdirSync(sessions);
    const old = new Date(Date.now() - 6 * DAY_MS);
    utimesSync(folder, old, old);
    const started = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<void>();
    let guarded = false;
    const sweeping = pruneScratch(scratch, sessions, {
        removeIfUnowned: async (_id, detach) => {
            guarded = true;
            try { return await detach(() => true); }
            finally { guarded = false; }
        },
        removeDirectory: async (path) => {
            expect(guarded).toBe(false);
            started.resolve(path);
            await finish.promise;
            await rm(path, { recursive: true, force: true });
        },
    });
    try {
        const detached = await started.promise;
        expect(detached.startsWith(join(scratch, ".removing-old-"))).toBe(true);
        expect(existsSync(folder)).toBe(false);
        expect(existsSync(detached)).toBe(true);
        mkdirSync(folder);
        writeFileSync(join(folder, "new"), "new session scratch");
        finish.resolve();
        expect((await sweeping).removedDirectories).toBe(1);
        expect(existsSync(detached)).toBe(false);
        expect(existsSync(join(folder, "new"))).toBe(true);
    } finally {
        finish.resolve();
        await sweeping;
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core sessions named like detached scratch still use their session file age", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-named-removing-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    const id = ".removing-like-a-session";
    const folder = join(scratch, id);
    const session = join(sessions, `${id}.jsonl`);
    mkdirSync(folder, { recursive: true });
    mkdirSync(sessions);
    await SessionStore.create(session, { sessionId: id, cwd: root });
    const options = { removeIfUnowned: (_id: string, detach: GuardedScratchDetach) => detach(() => true) };
    try {
        expect((await pruneScratch(scratch, sessions, options)).removedDirectories).toBe(0);
        expect(existsSync(folder)).toBe(true);
        const old = new Date(Date.now() - 6 * DAY_MS);
        utimesSync(session, old, old);
        expect((await pruneScratch(scratch, sessions, options)).removedDirectories).toBe(1);
        expect(existsSync(folder)).toBe(false);
        expect(existsSync(session)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core failed scratch removal leaves a detached folder for the next sweep", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-retry-"));
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    const folder = join(scratch, "old");
    mkdirSync(folder, { recursive: true });
    mkdirSync(sessions);
    const old = new Date(Date.now() - 6 * DAY_MS);
    utimesSync(folder, old, old);
    try {
        const first = await pruneScratch(scratch, sessions, {
            removeIfUnowned: (_id, detach) => detach(() => true),
            removeDirectory: async () => { throw new Error("remove failed"); },
        });
        expect(first.removedDirectories).toBe(0);
        expect(existsSync(folder)).toBe(false);
        const leftovers = readdirSync(scratch);
        expect(leftovers).toHaveLength(1);
        expect(leftovers[0]?.startsWith(".removing-old-")).toBe(true);
        const second = await pruneScratch(scratch, sessions, {
            removeIfUnowned: (_id, detach) => detach(() => true),
        });
        expect(second.removedDirectories).toBe(1);
        expect(readdirSync(scratch)).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a changed retention config applies to the next scratch sweep", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-config-sweep-"));
    const path = join(root, "config.json");
    const scratch = join(root, "scratch");
    const sessions = join(root, "sessions");
    const folder = join(scratch, "saved");
    const session = join(sessions, "saved.jsonl");
    mkdirSync(folder, { recursive: true });
    mkdirSync(sessions);
    await SessionStore.create(session, { sessionId: "saved", cwd: root });
    const old = new Date(Date.now() - 3 * DAY_MS);
    utimesSync(session, old, old);
    writeFileSync(path, JSON.stringify({ schema_version: 1, model: "anthropic/example-model" }));
    const read = createLiveVeraConfigReader(loadVeraConfig({ path }), { path });
    const sweep = () => pruneScratch(scratch, sessions, {
        maxAgeMs: scratchMaxAgeMs(read()),
        removeIfUnowned: (_id, detach) => detach(() => true),
    });
    try {
        expect((await sweep()).removedDirectories).toBe(0);
        writeFileSync(`${path}.new`, JSON.stringify({
            schema_version: 1, model: "anthropic/example-model", scratch_max_age_days: 2,
        }));
        renameSync(`${path}.new`, path);
        expect((await sweep()).removedDirectories).toBe(1);
        expect(existsSync(folder)).toBe(false);
        expect(existsSync(session)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core scratch retention config defaults to four days and validates positive whole days", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-scratch-config-"));
    const path = join(root, "config.json");
    try {
        writeFileSync(path, JSON.stringify({ schema_version: 1, model: "anthropic/example-model" }));
        const defaults = loadVeraConfig({ path });
        expect(defaults.scratch_max_age_days).toBeUndefined();
        expect(scratchMaxAgeMs(defaults)).toBe(DEFAULT_SCRATCH_MAX_AGE_MS);

        writeFileSync(path, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            scratch_max_age_days: 2,
        }));
        expect(scratchMaxAgeMs(loadVeraConfig({ path }))).toBe(2 * DAY_MS);

        const read = createLiveVeraConfigReader(loadVeraConfig({ path }), { path });
        for (const invalid of [0, -1, 1.5, "7", null]) {
            writeFileSync(`${path}.new`, JSON.stringify({
                schema_version: 1,
                model: "anthropic/example-model",
                scratch_max_age_days: invalid,
            }));
            renameSync(`${path}.new`, path);
            expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
            expect(() => loadVeraConfig({ path })).toThrow("scratch_max_age_days");
            expect(scratchMaxAgeMs(read())).toBe(2 * DAY_MS);
        }

        writeFileSync(`${path}.new`, JSON.stringify({
            schema_version: 1,
            model: "anthropic/example-model",
            scratch_max_age_days: 3,
        }));
        renameSync(`${path}.new`, path);
        expect(scratchMaxAgeMs(read())).toBe(3 * DAY_MS);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
