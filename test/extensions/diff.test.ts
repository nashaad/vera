import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFilePatch, readWorkspaceDiff } from "../../extensions/diff/model.ts";

const directories: string[] = [];
const signal = new AbortController().signal;
function repository(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-diff-test-"));
    directories.push(root);
    git(root, "init", "-q");
    return root;
}
function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
function commit(root: string): void {
    git(root, "add", ".");
    git(root, "-c", "user.name=nashaad", "-c", "user.email=nashaad@gmail.com", "-c", "commit.gpgsign=false", "commit", "-qm", "test: seed files");
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("workspace diff includes staged, unstaged, deleted, binary and untracked files from a nested workspace", async () => {
    const root = repository();
    writeFileSync(join(root, "changed.txt"), "old\n");
    writeFileSync(join(root, "deleted.txt"), "gone\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    commit(root);
    writeFileSync(join(root, "changed.txt"), "staged\n");
    git(root, "add", "changed.txt");
    writeFileSync(join(root, "changed.txt"), "new\nsecond\n");
    unlinkSync(join(root, "deleted.txt"));
    writeFileSync(join(root, "new\tfile.txt"), "new file\n");
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "ignored.txt"), "ignored\n");
    mkdirSync(join(root, "nested"));
    const snapshot = await readWorkspaceDiff(join(root, "nested"), signal);
    expect(snapshot.files).toHaveLength(4);
    const changed = snapshot.files.find((file) => file.path === "changed.txt")!;
    expect(changed).toMatchObject({ additions: 2, deletions: 1, status: "Modified" });
    const patch = await readFilePatch(snapshot, changed, signal);
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
    expect(patch).not.toContain("+staged");
    expect(snapshot.files.find((file) => file.path === "deleted.txt")).toMatchObject({ status: "Deleted", deletions: 1 });
    expect(snapshot.files.find((file) => file.path === "binary.bin")).toMatchObject({ binary: true });
    const added = snapshot.files.find((file) => file.path === "new\tfile.txt")!;
    expect(added).toMatchObject({ status: "Untracked", additions: 1 });
    expect(await readFilePatch(snapshot, added, signal)).toContain("+new file");
});

test("empty and unborn repositories work; symlink previews show the link rather than its target", async () => {
    const root = repository();
    expect((await readWorkspaceDiff(root, signal)).files).toEqual([]);
    writeFileSync(join(root, "first.txt"), "first\n");
    git(root, "add", "first.txt");
    symlinkSync("first.txt", join(root, "link"));
    const snapshot = await readWorkspaceDiff(root, signal);
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files.find((file) => file.path === "first.txt")).toMatchObject({ status: "Added", additions: 1 });
    const link = snapshot.files.find((file) => file.path === "link")!;
    expect(await readFilePatch(snapshot, link, signal)).toContain("+first.txt");
    commit(root);
    expect((await readWorkspaceDiff(root, signal)).files).toEqual([]);
});

test("non-repositories and cancellation are explicit", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-no-git-"));
    directories.push(root);
    await expect(readWorkspaceDiff(root, signal)).rejects.toThrow("not an accessible Git repository");
    const controller = new AbortController();
    controller.abort();
    await expect(readWorkspaceDiff(root, controller.signal)).rejects.toThrow();
});
