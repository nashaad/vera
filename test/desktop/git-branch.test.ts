import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBranch } from "../../clients/desktop/src/git-branch.ts";

const roots: string[] = [];
const SHA = "0123456789abcdef0123456789abcdef01234567";

function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-git-branch-"));
    roots.push(root);
    return root;
}

function writeFile(path: string, text: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("reads the branch of a repository's root", async () => {
    const root = fixtureRoot();
    writeFile(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(await readBranch(join(root, "repo"))).toBe("main");
});

test("walks up from a nested folder to the repository", async () => {
    const root = fixtureRoot();
    writeFile(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/feat/desktop-shell\n");
    mkdirSync(join(root, "repo", "clients", "desktop", "src"), { recursive: true });
    expect(await readBranch(join(root, "repo", "clients", "desktop", "src"))).toBe("feat/desktop-shell");
});

test("a detached HEAD reports the first seven characters of the sha", async () => {
    const root = fixtureRoot();
    writeFile(join(root, "repo", ".git", "HEAD"), `${SHA}\n`);
    expect(await readBranch(join(root, "repo"))).toBe("0123456");
});

test("follows a worktree's .git file with a relative gitdir", async () => {
    const root = fixtureRoot();
    writeFile(join(root, "repo", ".git", "worktrees", "desktop", "HEAD"), "ref: refs/heads/worktree-branch\n");
    writeFile(join(root, "repo", ".worktrees", "desktop", ".git"), "gitdir: ../../.git/worktrees/desktop\n");
    mkdirSync(join(root, "repo", ".worktrees", "desktop", "src"), { recursive: true });
    expect(await readBranch(join(root, "repo", ".worktrees", "desktop", "src"))).toBe("worktree-branch");
});

test("returns undefined when no repository exists above the folder", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "plain", "folder"), { recursive: true });
    expect(await readBranch(join(root, "plain", "folder"))).toBeUndefined();
});
