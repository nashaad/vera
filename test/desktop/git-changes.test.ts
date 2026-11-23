import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGitTask } from "../../clients/shared/git-changes.ts";
import { MAX_FILE_LINE_CHANGES, type GitTaskReply } from "../../clients/shared/git-wire.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-git-changes-"));
    roots.push(root);
    return root;
}

function env(root: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Vera Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Vera Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
    };
}

function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, env: env(root), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeFile(path: string, contents: string | Uint8Array): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
}

interface Fixture {
    readonly root: string;
    readonly repo: string;
}

// main has four tracked files; feature changes each kind of file and leaves one
// untracked file, which the uncommitted scope must find on its own.
function repository(): Fixture {
    const root = fixtureRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFile(join(repo, "a.txt"), "one\n");
    writeFile(join(repo, "gone.txt"), "bye\n");
    writeFile(join(repo, "old name.txt"), "old\n");
    writeFile(join(repo, "src", "b.ts"), "const b = 1;\n");
    writeFile(join(repo, "blob.bin"), new Uint8Array([0, 1, 2, 3]));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "initial");
    git(repo, "branch", "feature");
    git(repo, "checkout", "-q", "feature");
    writeFile(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "mv", "old name.txt", "new name.txt");
    rmSync(join(repo, "gone.txt"));
    writeFile(join(repo, "src", "b.ts"), "const b = 2;\n");
    writeFile(join(repo, "blob.bin"), new Uint8Array([0, 1, 2, 4]));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feature");
    writeFile(join(repo, "untracked.txt"), "new one\nnew two\n");
    return { root, repo };
}

function expectOk<T extends GitTaskReply>(reply: T): T {
    if (!reply.ok) throw new Error(reply.reason);
    return reply;
}

test("changed lines combine staged and unstaged edits and treat untracked paths literally", async () => {
    const { repo } = repository();
    writeFile(join(repo, "src", "b.ts"), "const b = 3;\n");
    git(repo, "add", "src/b.ts");
    writeFile(join(repo, "src", "b.ts"), "const b = 4;\nextra\n");
    expect(await runGitTask({ kind: "changedLines", folder: repo, path: "src/b.ts" })).toEqual({
        kind: "changedLines",
        ok: true,
        changes: [{ kind: "changed", start: 1, end: 1 }, { kind: "added", start: 2, end: 2 }],
    });

    writeFile(join(repo, "(literal)[name].txt"), "new\ntext\n");
    writeFile(join(repo, "tracked-new.ts"), "one\ntwo\n");
    git(repo, "add", "tracked-new.ts");
    expect(await runGitTask({ kind: "changedLines", folder: repo, path: "tracked-new.ts" })).toEqual({
        kind: "changedLines",
        ok: true,
        changes: [{ kind: "added", start: 1, end: 2 }],
    });
    expect(await runGitTask({ kind: "changedLines", folder: repo, path: "(literal)[name].txt" })).toEqual({
        kind: "changedLines",
        ok: true,
        changes: [{ kind: "added", start: 1, end: 2 }],
    });
});

test("changed lines use new-side positions for removals and return null when unavailable", async () => {
    const { root, repo } = repository();
    writeFile(join(repo, "src", "b.ts"), "const b = 2;\n");
    const changed = await runGitTask({ kind: "changedLines", folder: repo, path: "src/b.ts" });
    expect(changed).toEqual({ kind: "changedLines", ok: true, changes: [] });

    writeFile(join(repo, "gap.txt"), "one\ntwo\nthree\nfour\nfive\n");
    git(repo, "add", "gap.txt");
    git(repo, "commit", "-q", "-m", "gap base");
    writeFile(join(repo, "gap.txt"), "one\ntwo\nTHREE\nfive\n");
    const mixedGap = await runGitTask({ kind: "changedLines", folder: repo, path: "gap.txt" });
    expect(mixedGap).toEqual({
        kind: "changedLines",
        ok: true,
        changes: [{ kind: "changed", start: 3, end: 3 }, { kind: "removed", start: 4, end: 4 }],
    });

    writeFile(join(repo, "a.txt"), "one\n");
    const removed = await runGitTask({ kind: "changedLines", folder: repo, path: "a.txt" });
    expect(removed).toEqual({ kind: "changedLines", ok: true, changes: [{ kind: "removed", start: 2, end: 2 }] });

    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await runGitTask({ kind: "changedLines", folder: plain, path: "a.txt" })).toEqual({ kind: "changedLines", ok: true, changes: null });
    expect(await runGitTask({ kind: "changedLines", folder: repo, path: "missing.txt" })).toEqual({ kind: "changedLines", ok: true, changes: null });
});

test("changed lines resolve paths relative to a nested session folder", async () => {
    const { repo } = repository();
    writeFile(join(repo, "src", "b.ts"), "const b = 3;\nextra\n");
    expect(await runGitTask({ kind: "changedLines", folder: join(repo, "src"), path: "b.ts" })).toEqual({
        kind: "changedLines",
        ok: true,
        changes: [{ kind: "changed", start: 1, end: 1 }, { kind: "added", start: 2, end: 2 }],
    });
});

test("changed lines follow symlinked session folders for nested literal paths", async () => {
    const { root, repo } = repository();
    const alias = join(root, "linked repo");
    symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    const tracked = "(tracked)[crow].txt";
    const untracked = "(new)[nest].txt";
    writeFile(join(repo, "src", tracked), "one\n");
    git(repo, "add", "--", `src/${tracked}`);
    git(repo, "commit", "-q", "-m", "tracked literal path");
    writeFile(join(repo, "src", tracked), "changed\ntwo\n");
    writeFile(join(repo, "src", untracked), "new\nlines\n");

    const modifiedReply = {
        kind: "changedLines",
        ok: true,
        changes: [{ kind: "changed", start: 1, end: 1 }, { kind: "added", start: 2, end: 2 }],
    } as const;
    const untrackedReply = { kind: "changedLines", ok: true, changes: [{ kind: "added", start: 1, end: 2 }] } as const;
    for (const folder of [repo, alias]) {
        expect(await runGitTask({ kind: "changedLines", folder, path: `src/${tracked}` })).toEqual(modifiedReply);
        expect(await runGitTask({ kind: "changedLines", folder, path: `src/${untracked}` })).toEqual(untrackedReply);
        expect(await runGitTask({ kind: "changedLines", folder: join(folder, "src"), path: tracked })).toEqual(modifiedReply);
        expect(await runGitTask({ kind: "changedLines", folder: join(folder, "src"), path: untracked })).toEqual(untrackedReply);
    }
});

test("untracked line counts read only a bounded file head", async () => {
    const { repo } = repository();
    writeFile(join(repo, "large.txt"), "x\n".repeat(300_000));
    const reply = await runGitTask({ kind: "changedLines", folder: repo, path: "large.txt" });
    expect(reply).toEqual({ kind: "changedLines", ok: true, changes: [{ kind: "added", start: 1, end: 204_800 }] });
});

test("changed-line ranges stop at 500 entries", async () => {
    expect(MAX_FILE_LINE_CHANGES).toBe(500);
    const { repo } = repository();
    const before = Array.from({ length: 1_002 }, (_, index) => `line ${index}`).join("\n") + "\n";
    const after = Array.from({ length: 1_002 }, (_, index) => index % 2 === 0 ? `changed ${index}` : `line ${index}`).join("\n") + "\n";
    writeFile(join(repo, "src", "b.ts"), before);
    git(repo, "add", "src/b.ts");
    git(repo, "commit", "-q", "-m", "many changes base");
    writeFile(join(repo, "src", "b.ts"), after);
    const reply = await runGitTask({ kind: "changedLines", folder: repo, path: "src/b.ts" });
    expect(reply.kind).toBe("changedLines");
    if (reply.kind === "changedLines" && reply.ok) expect(reply.changes).toHaveLength(500);
});

test("state follows the current branch and the default destination", async () => {
    const { repo } = repository();
    const reply = expectOk(await runGitTask({ kind: "state", folder: repo }) as Extract<GitTaskReply, { kind: "state" }>);
    if (reply.kind !== "state" || !reply.ok) throw new Error("state reply expected");
    expect(reply.state.repo).toBe(true);
    expect(reply.state.root).toBe(repo);
    expect(reply.state.branch).toBe("feature");
    expect(reply.state.detached).toBe(false);
    expect(reply.state.hasCommits).toBe(true);
    expect(reply.state.branches.map((branch) => branch.name)).toContain("main");
    expect(reply.state.branchesPartial).toBe(false);
    expect(reply.state.defaultDestination).toBe("main");
});

test("the upstream wins over origin/HEAD, then main, then master", async () => {
    const { repo } = repository();
    git(repo, "branch", "--set-upstream-to=main", "feature");
    let reply = expectOk(await runGitTask({ kind: "state", folder: repo }) as Extract<GitTaskReply, { kind: "state" }>);
    if (reply.kind !== "state" || !reply.ok) throw new Error("state reply expected");
    expect(reply.state.upstream).toBe("main");
    expect(reply.state.defaultDestination).toBe("main");

    git(repo, "branch", "--unset-upstream");
    git(repo, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    reply = expectOk(await runGitTask({ kind: "state", folder: repo }) as Extract<GitTaskReply, { kind: "state" }>);
    if (reply.kind !== "state" || !reply.ok) throw new Error("state reply expected");
    expect(reply.state.defaultDestination).toBe("origin/main");
});

test("branch files cover the whole committed diff and keep whole-diff totals", async () => {
    const { repo } = repository();
    const reply = await runGitTask({ kind: "files", folder: repo, scope: "branch", destination: "main" });
    if (reply.kind !== "files" || !reply.ok) throw new Error("files reply expected");
    const list = reply.list;
    expect(list.noMergeBase).toBe(false);
    expect(list.total).toBe(5);
    expect(list.files.map((file) => file.path).sort()).toEqual(["a.txt", "blob.bin", "gone.txt", "new name.txt", "src/b.ts"]);
    const renamed = list.files.find((file) => file.path === "new name.txt");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.prevPath).toBe("old name.txt");
    expect(renamed?.added).toBe(0);
    expect(renamed?.removed).toBe(0);
    const binary = list.files.find((file) => file.path === "blob.bin");
    expect(binary?.binary).toBe(true);
    expect(binary?.added).toBeNull();
    expect(binary?.removed).toBeNull();
    expect(list.added).toBe(2);
    expect(list.removed).toBe(2);
    expect(list.totalsPartial).toBe(false);
    expect(list.files.some((file) => file.path === "untracked.txt")).toBe(false);
});

test("the uncommitted scope lists untracked files as additions", async () => {
    const { repo } = repository();
    const reply = await runGitTask({ kind: "files", folder: repo, scope: "uncommitted", destination: null });
    if (reply.kind !== "files" || !reply.ok) throw new Error("files reply expected");
    expect(reply.list.total).toBe(1);
    expect(reply.list.files).toEqual([{
        path: "untracked.txt",
        status: "untracked",
        added: 2,
        removed: 0,
        binary: false,
    }]);
    expect(reply.list.added).toBe(2);
    expect(reply.list.removed).toBe(0);
});

test("the uncommitted scope covers staged and unstaged files", async () => {
    const { repo } = repository();
    writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
    writeFile(join(repo, "src", "b.ts"), "const b = 3;\n");
    git(repo, "add", "src/b.ts");
    const reply = await runGitTask({ kind: "files", folder: repo, scope: "uncommitted", destination: null });
    if (reply.kind !== "files" || !reply.ok) throw new Error("files reply expected");
    const staged = reply.list.files.find((file) => file.path === "src/b.ts");
    expect(staged?.status).toBe("modified");
    expect(staged?.added).toBe(1);
    expect(staged?.removed).toBe(1);
    const unstaged = reply.list.files.find((file) => file.path === "a.txt");
    expect(unstaged?.status).toBe("modified");
    expect(unstaged?.added).toBe(1);
    expect(unstaged?.removed).toBe(0);
    expect(reply.list.total).toBe(3);
    expect(reply.list.added).toBe(4);
    expect(reply.list.removed).toBe(1);
});

test("patches carry renames, deletions, binaries and untracked files", async () => {
    const { repo } = repository();
    const files = await runGitTask({ kind: "files", folder: repo, scope: "branch", destination: "main" });
    if (files.kind !== "files" || !files.ok) throw new Error("files reply expected");
    const targets = files.list.files.map((file) => ({ path: file.path, status: file.status, ...(file.prevPath === undefined ? {} : { prevPath: file.prevPath }) }));
    const reply = await runGitTask({ kind: "patches", folder: repo, scope: "branch", destination: "main", files: targets });
    if (reply.kind !== "patches" || !reply.ok) throw new Error("patches reply expected");
    expect(reply.patches).toHaveLength(5);
    const rename = reply.patches.find((patch) => patch.path === "new name.txt");
    expect(rename?.patch).toContain("rename from old name.txt");
    expect(rename?.patch).toContain("rename to new name.txt");
    const deleted = reply.patches.find((patch) => patch.path === "gone.txt");
    expect(deleted?.patch).toContain("deleted file mode");
    expect(deleted?.newBytes).toBeNull();
    const binary = reply.patches.find((patch) => patch.path === "blob.bin");
    expect(binary?.binary).toBe(true);
    expect(binary?.patch).toContain("Binary files");

    const untracked = await runGitTask({
        kind: "patches",
        folder: repo,
        scope: "uncommitted",
        destination: null,
        files: [{ path: "untracked.txt", status: "untracked" }],
    });
    if (untracked.kind !== "patches" || !untracked.ok) throw new Error("patches reply expected");
    expect(untracked.patches[0]?.patch).toContain("+new one");
    expect(untracked.patches[0]?.oldBytes).toBeNull();
});

test("texts read both sides at the merge base and HEAD, and report an oversized side", async () => {
    const { repo } = repository();
    const reply = await runGitTask({
        kind: "texts",
        folder: repo,
        scope: "branch",
        destination: "main",
        file: { path: "a.txt", status: "modified" },
    });
    if (reply.kind !== "texts" || !reply.ok) throw new Error("texts reply expected");
    expect(reply.texts.old?.contents).toBe("one\n");
    expect(reply.texts.new?.contents).toBe("one\ntwo\n");
    expect(reply.texts.old?.cacheKey).toContain(":a.txt");
    expect(reply.texts.new?.cacheKey).toContain("HEAD:a.txt");
    expect(reply.texts.oldTooLarge).toBe(false);

    writeFile(join(repo, "big.txt"), "x".repeat(500 * 1024));
    git(repo, "add", "big.txt");
    git(repo, "commit", "-q", "-m", "big");
    const big = await runGitTask({
        kind: "texts",
        folder: repo,
        scope: "branch",
        destination: "main",
        file: { path: "big.txt", status: "added" },
    });
    if (big.kind !== "texts" || !big.ok) throw new Error("texts reply expected");
    expect(big.texts.old).toBeNull();
    expect(big.texts.new).toBeNull();
    expect(big.texts.newTooLarge).toBe(true);
});

test("refusals use one sentence each, and a missing merge base is a result", async () => {
    const { root, repo } = repository();
    const plain = join(root, "plain");
    mkdirSync(plain);
    const notRepo = await runGitTask({ kind: "files", folder: plain, scope: "uncommitted", destination: null });
    expect(notRepo).toEqual({ kind: "failure", ok: false, reason: "This folder is not a git repository." });

    const missing = await runGitTask({
        kind: "files",
        folder: repo,
        scope: "branch",
        destination: "nope",
        });
    expect(missing).toEqual({ kind: "failure", ok: false, reason: "That branch is no longer in this repository." });

    const traversal = await runGitTask({
        kind: "texts",
        folder: repo,
        scope: "branch",
        destination: "main",
        file: { path: "../secret", status: "modified" },
    });
    expect(traversal).toEqual({ kind: "failure", ok: false, reason: "Could not read the changes." });

    const empty = join(root, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    const noCommits = await runGitTask({ kind: "files", folder: empty, scope: "uncommitted", destination: null });
    expect(noCommits).toEqual({ kind: "failure", ok: false, reason: "This repository has no commits yet." });

    git(repo, "checkout", "-q", "--orphan", "lonely");
    git(repo, "commit", "-q", "-m", "lonely");
    const lonely = await runGitTask({ kind: "files", folder: repo, scope: "branch", destination: "main" });
    if (lonely.kind !== "files" || !lonely.ok) throw new Error("files reply expected");
    expect(lonely.list.noMergeBase).toBe(true);
    expect(lonely.list.files).toEqual([]);
});

test("a detached HEAD reads as its short SHA, and origin/HEAD stays out of the branch list", async () => {
    const { repo } = repository();
    git(repo, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(repo, "checkout", "-q", "--detach", "HEAD");
    const reply = await runGitTask({ kind: "state", folder: repo });
    if (reply.kind !== "state" || !reply.ok) throw new Error("state reply expected");
    expect(reply.state.detached).toBe(true);
    expect(reply.state.branch).toBeNull();
    expect(reply.state.head).toMatch(/^[0-9a-f]{7,12}$/);
    expect(reply.state.branches.map((branch) => branch.name)).not.toContain("origin/HEAD");
    expect(reply.state.defaultDestination).toBe("origin/main");
});

test("a path with a space and non-ASCII characters is kept as written", async () => {
    const { root } = repository();
    const repo = join(root, "unicode");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    const path = "naïve notes/日本語 file.txt";
    writeFile(join(repo, path), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFile(join(repo, path), "one\ntwo\n");
    git(repo, "commit", "-q", "-am", "feature");
    const files = await runGitTask({ kind: "files", folder: repo, scope: "branch", destination: "main" });
    if (files.kind !== "files" || !files.ok) throw new Error("files reply expected");
    expect(files.list.files).toHaveLength(1);
    expect(files.list.files[0]?.path).toBe(path);
    expect(files.list.files[0]?.added).toBe(1);
    const patches = await runGitTask({
        kind: "patches",
        folder: repo,
        scope: "branch",
        destination: "main",
        files: [{ path, status: "modified" }],
    });
    if (patches.kind !== "patches" || !patches.ok) throw new Error("patches reply expected");
    expect(patches.patches[0]?.path).toBe(path);
    expect(patches.patches[0]?.patch).toContain("two");
});

test("the branch list stops at its cap and says it is partial", async () => {
    const { repo } = repository();
    const names = Array.from({ length: 2_001 }, (_, index) => `b${String(index).padStart(4, "0")}`);
    const head = git(repo, "rev-parse", "HEAD").trim();
    execFileSync("git", ["update-ref", "--stdin"], {
        cwd: repo,
        env: env(repo),
        input: `${names.map((name) => `create refs/heads/${name} ${head}`).join("\n")}\n`,
        stdio: ["pipe", "ignore", "pipe"],
    });
    const reply = await runGitTask({ kind: "state", folder: repo });
    if (reply.kind !== "state" || !reply.ok) throw new Error("state reply expected");
    expect(reply.state.branches).toHaveLength(2_000);
    expect(reply.state.branchesPartial).toBe(true);
});

test("the file list stops at its cap while the total keeps counting", async () => {
    const { root } = repository();
    const repo = join(root, "many");
    const dir = join(repo, "f");
    mkdirSync(dir, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    const count = 5_001;
    for (let index = 0; index < count; index += 1) {
        writeFileSync(join(dir, `${String(index).padStart(4, "0")}.txt`), "one\n");
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "feature");
    for (let index = 0; index < count; index += 1) {
        writeFileSync(join(dir, `${String(index).padStart(4, "0")}.txt`), "one\ntwo\n");
    }
    git(repo, "commit", "-q", "-am", "feature");
    const reply = await runGitTask({ kind: "files", folder: repo, scope: "branch", destination: "main" });
    if (reply.kind !== "files" || !reply.ok) throw new Error("files reply expected");
    expect(reply.list.files).toHaveLength(5_000);
    expect(reply.list.total).toBe(count);
    expect(reply.list.added).toBe(count);
    expect(reply.list.totalsPartial).toBe(false);
});

test("a patch request for more than six files is refused", async () => {
    const { repo } = repository();
    const file = { path: "a.txt", status: "modified" as const };
    const reply = await runGitTask({
        kind: "patches",
        folder: repo,
        scope: "branch",
        destination: "main",
        files: Array.from({ length: 7 }, () => file),
    });
    expect(reply).toEqual({ kind: "failure", ok: false, reason: "Could not read the changes." });
});
