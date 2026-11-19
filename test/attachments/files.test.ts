import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFile, FILE_SIZE_LIMIT, prepareFiles } from "../../src/attachments/files.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function root(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "vera-files-test-"));
    roots.push(path);
    return path;
}

test("copies chat files without overwriting and keeps real copies", async () => {
    const dir = await root();
    const chat = join(dir, "chat");
    await mkdir(chat);
    const file = join(dir, "report.txt");
    await writeFile(file, "new");
    await writeFile(join(chat, "report.txt"), "old");
    expect(await prepareFiles([file, file], { workspace: chat, chat: true })).toEqual(["report 2.txt", "report 3.txt"]);
    await writeFile(file, "changed");
    expect(await readFile(join(chat, "report.txt"), "utf8")).toBe("old");
    expect(await readFile(join(chat, "report 2.txt"), "utf8")).toBe("new");
});

test("refers to folder files and directories in place", async () => {
    const dir = await root();
    const work = join(dir, "work");
    await mkdir(work);
    const local = join(work, "a.txt");
    const outside = join(dir, "b.txt");
    await writeFile(local, "a");
    await writeFile(outside, "b");
    expect(await prepareFiles([local, outside, work], { workspace: work, chat: false })).toEqual(["a.txt", outside, "."]);
    await expect(checkFile(work, { workspace: work, chat: true })).rejects.toThrow("Folders cannot");
});

test("refuses too many files and oversized files", async () => {
    const dir = await root();
    const big = join(dir, "big");
    const handle = await openBig(big);
    await handle.close();
    await expect(checkFile(big, { workspace: dir, chat: true })).rejects.toThrow("20 MB");
    await expect(prepareFiles(Array(9).fill(big), { workspace: dir, chat: true })).rejects.toThrow("up to 8");
});

test("removes copies from a failed batch", async () => {
    const dir = await root();
    const chat = join(dir, "chat");
    await mkdir(chat);
    const source = join(dir, "a.txt");
    await writeFile(source, "a");
    await expect(prepareFiles([source, join(dir, "missing")], { workspace: chat, chat: true })).rejects.toThrow();
    await expect(readFile(join(chat, "a.txt"))).rejects.toThrow();
});

async function openBig(path: string) {
    const { open } = await import("node:fs/promises");
    const file = await open(path, "w");
    await file.truncate(FILE_SIZE_LIMIT + 1);
    return file;
}
