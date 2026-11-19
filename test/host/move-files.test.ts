import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelRequestSnapshotPath } from "../../src/engine/events.ts";
import {
    moveEventLog,
    moveFolderContents,
    returnEntries,
    returnFolderContents,
} from "../../src/host/agent-registry/move-files.ts";

async function withFolders<T>(body: (source: string, target: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "vera-move-files-"));
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(source);
    await mkdir(target);
    try {
        return await body(source, target);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("moving a folder's contents carries files, nested folders and links and removes the empty source", async () => {
    await withFolders(async (source, target) => {
        await mkdir(join(source, "deep", "er"), { recursive: true });
        await writeFile(join(source, "deep", "er", "file.txt"), "nested\n");
        await writeFile(join(source, ".hidden"), "dot\n");
        await symlink("deep", join(source, "link"));

        const outcome = await moveFolderContents(source, target);

        expect(outcome.status).toBe("moved");
        expect((await readdir(target)).sort()).toEqual([".hidden", "deep", "link"]);
        expect(await readFile(join(target, "deep", "er", "file.txt"), "utf8")).toBe("nested\n");
        expect(await readlink(join(target, "link"))).toBe("deep");
        await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    });
});

test("a name that is taken in the target moves nothing and leaves the target's file alone", async () => {
    await withFolders(async (source, target) => {
        await writeFile(join(source, "a.txt"), "source a\n");
        await writeFile(join(source, "b.txt"), "source b\n");
        await writeFile(join(target, "b.txt"), "target b\n");

        const outcome = await moveFolderContents(source, target);

        expect(outcome).toEqual({ status: "collision" });
        expect((await readdir(source)).sort()).toEqual(["a.txt", "b.txt"]);
        expect(await readFile(join(source, "a.txt"), "utf8")).toBe("source a\n");
        expect(await readFile(join(source, "b.txt"), "utf8")).toBe("source b\n");
        expect(await readdir(target)).toEqual(["b.txt"]);
        expect(await readFile(join(target, "b.txt"), "utf8")).toBe("target b\n");
    });
});

test("a broken link in the target counts as taken", async () => {
    await withFolders(async (source, target) => {
        await writeFile(join(source, "dangling"), "x\n");
        await symlink("nowhere", join(target, "dangling"));

        expect(await moveFolderContents(source, target)).toEqual({ status: "collision" });
        expect(await readdir(source)).toEqual(["dangling"]);
    });
});

test("returning moved names puts back only those and keeps the target's other files", async () => {
    await withFolders(async (source, target) => {
        await writeFile(join(source, "mine.txt"), "mine\n");
        await writeFile(join(target, "theirs.txt"), "theirs\n");
        const outcome = await moveFolderContents(source, target);
        expect(outcome.status).toBe("moved");
        if (outcome.status !== "moved") return;

        await returnFolderContents(source, target, outcome.names);

        expect(await readFile(join(source, "mine.txt"), "utf8")).toBe("mine\n");
        expect(await readdir(target)).toEqual(["theirs.txt"]);
    });
});

test("an empty or already removed source moves nothing", async () => {
    await withFolders(async (source, target) => {
        expect(await moveFolderContents(source, target)).toEqual({ status: "moved", names: [] });
        expect(await moveFolderContents(source, target)).toEqual({ status: "moved", names: [] });
        expect(await readdir(target)).toEqual([]);
    });
});

test("moving an event log carries the snapshot beside it, creates the new key's folder and can be returned", async () => {
    await withFolders(async (source, target) => {
        const from = join(source, "key-a", "agent.jsonl");
        const to = join(target, "key-b", "agent.jsonl");
        await mkdir(join(source, "key-a"));
        await writeFile(from, "log\n");
        await writeFile(modelRequestSnapshotPath(from), "snapshot\n");

        const moved = await moveEventLog(from, to);

        expect(moved).toHaveLength(2);
        expect(await readFile(to, "utf8")).toBe("log\n");
        expect(await readFile(modelRequestSnapshotPath(to), "utf8")).toBe("snapshot\n");
        await expect(stat(from)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(modelRequestSnapshotPath(from))).rejects.toMatchObject({ code: "ENOENT" });

        await returnEntries(moved);

        expect(await readFile(from, "utf8")).toBe("log\n");
        expect(await readFile(modelRequestSnapshotPath(from), "utf8")).toBe("snapshot\n");
        await expect(stat(to)).rejects.toMatchObject({ code: "ENOENT" });
    });
});

test("moving an event log skips a missing source and never overwrites a destination", async () => {
    await withFolders(async (source, target) => {
        const from = join(source, "agent.jsonl");
        const to = join(target, "agent.jsonl");

        expect(await moveEventLog(from, to)).toEqual([]);
        await expect(stat(to)).rejects.toMatchObject({ code: "ENOENT" });

        await writeFile(from, "old\n");
        await writeFile(to, "taken\n");
        await writeFile(modelRequestSnapshotPath(from), "snapshot\n");

        const moved = await moveEventLog(from, to);

        expect(moved.map((entry) => entry.from)).toEqual([modelRequestSnapshotPath(from)]);
        expect(await readFile(from, "utf8")).toBe("old\n");
        expect(await readFile(to, "utf8")).toBe("taken\n");
        expect(await readFile(modelRequestSnapshotPath(to), "utf8")).toBe("snapshot\n");
    });
});

test("a failed event log move leaves the source where it was", async () => {
    await withFolders(async (source, target) => {
        const from = join(source, "agent.jsonl");
        await writeFile(from, "log\n");
        await writeFile(join(target, "blocker"), "a file, not a folder\n");

        await expect(moveEventLog(from, join(target, "blocker", "agent.jsonl"))).rejects.toThrow();

        expect(await readFile(from, "utf8")).toBe("log\n");
    });
});
