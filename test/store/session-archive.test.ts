import { afterAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore, readSessionIndexMetadata } from "../../src/store/session-store.ts";
import { sessionMetadataPath } from "../../src/store/session-metadata.ts";
import { createSessionBranch } from "../../src/store/session-branch.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { rewriteSessionCwd } from "../../src/store/session-cwd.ts";

const directories: string[] = [];

afterAll(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("session archive state persists across later appends and store reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-session-archive-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "session-1", cwd: directory });

    expect(store.archived()).toBe(false);
    await store.setArchived(true);
    await store.appendName("Still the same session");
    expect(store.archived()).toBe(true);

    const reopened = await SessionStore.open(path);
    expect(reopened.archived()).toBe(true);
    await reopened.setArchived(false);
    expect((await SessionStore.open(path)).archived()).toBe(false);
});

test("sessions without metadata remain unarchived", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-session-unarchived-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, { sessionId: "legacy-session", cwd: directory });
    expect((await SessionStore.open(path)).archived()).toBe(false);
});

test("archive metadata is bounded and strictly parsed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-archive-metadata-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "strict", cwd: directory });
    await store.setArchived(true);
    expect((await readSessionIndexMetadata(path)).archived).toBe(true);
    expect(await readFile(path, "utf8")).not.toContain("session_archived");
    for (const value of ['{"archived":"true"}', '{"archived":true,"extra":1}', " ".repeat(257)]) {
        await writeFile(sessionMetadataPath(path), value);
        await expect(readSessionIndexMetadata(path)).rejects.toThrow("Invalid session metadata");
        await expect(SessionStore.open(path)).rejects.toThrow("Invalid session metadata");
    }
});

test("clone starts unarchived and trash bundles and restores metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-archive-lifecycle-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "original", cwd: directory });
    await store.setArchived(true);
    const clone = await createSessionBranch({ source: store, destinationPath: join(directory, "clone.jsonl"), sessionId: "clone", position: "at" });
    expect(clone.store.archived()).toBe(false);
    expect((await SessionStore.open(clone.store.path)).archived()).toBe(false);
    const bundle = join(directory, "trash-copy");
    await trashSessionArtifacts({ sessionPath: path, attachmentsPath: `${path}.attachments`, filesPath: join(directory, "files") }, {
        moveToTrash: async ([staged]) => { await cp(staged!, bundle, { recursive: true }); },
    });
    expect(JSON.parse(await readFile(join(bundle, "session.jsonl.metadata.json"), "utf8"))).toEqual({ archived: true });
    await cp(join(bundle, "session.jsonl"), path);
    await cp(join(bundle, "session.jsonl.metadata.json"), sessionMetadataPath(path));
    expect((await SessionStore.open(path)).archived()).toBe(true);
});

test("workspace move preserves archive metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-archive-move-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "move", cwd: directory });
    await store.setArchived(true);
    await rewriteSessionCwd(path, join(directory, "workspace"));
    expect((await SessionStore.open(path)).archived()).toBe(true);
});

test("trash rollback restores metadata after removal failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-archive-rollback-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "rollback", cwd: directory });
    await store.setArchived(true);
    await expect(trashSessionArtifacts({ sessionPath: path, attachmentsPath: `${path}.attachments`, filesPath: join(directory, "files") }, {
        moveToTrash: async () => {},
        removeOriginal: async (item) => {
            if (item === path) throw new Error("removal failed");
            await rm(item, { recursive: true });
        },
    })).rejects.toThrow("removal failed");
    expect((await SessionStore.open(path)).archived()).toBe(true);
});
