import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectReviewerPathFacts } from "../../src/engine/reviewer-path-facts.ts";
import type { PermissionActionDecision } from "../../src/engine/permissions.ts";
import { git, removeGitRepositories, repository } from "../support/git-repositories.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const path of temporaryDirectories.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
    removeGitRepositories();
});

test("reviewer path facts describe files and bounded directory trees without content", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(join(outside, "nested"), { recursive: true });
    writeFileSync(join(outside, "first.txt"), "abc");
    writeFileSync(join(outside, "nested", "second.txt"), "de");

    const facts = await collectReviewerPathFacts(
        workspace,
        {
            id: "write-outside",
            name: "write",
            input: { path: "../outside" },
        },
        [pathAction(outside)],
    );

    expect(facts[0]).toEqual({
        requestedPath: "../outside",
        resolvedPath: realpathSync(outside),
        scope: "outside_workspace",
        exists: true,
        type: "directory",
        entryCount: 3,
        totalBytes: 5,
        truncated: false,
        trackedGitState: "not_repository",
    });
    expect(JSON.stringify(facts)).not.toContain("abc");
    expect(JSON.stringify(facts)).not.toContain("first.txt");
});

test("reviewer path facts disclose a symlink target and a missing destination", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    const target = join(root, "target.txt");
    const link = join(workspace, "linked.txt");
    mkdirSync(workspace);
    writeFileSync(target, "target");
    symlinkSync(target, link);

    const linked = await collectReviewerPathFacts(
        workspace,
        {
            id: "read-link",
            name: "read",
            input: { path: "linked.txt" },
        },
        [pathAction(target, "read")],
    );
    expect(linked[0]).toMatchObject({
        requestedPath: "linked.txt",
        resolvedPath: realpathSync(target),
        scope: "outside_workspace",
        exists: true,
        type: "symbolic_link",
        symlinkTarget: realpathSync(target),
    });

    const missingPath = join(root, "new-note.md");
    const missing = await collectReviewerPathFacts(
        workspace,
        {
            id: "write-missing",
            name: "write",
            input: { path: "../new-note.md", content: "new" },
        },
        [pathAction(missingPath)],
    );
    expect(missing[0]).toMatchObject({
        requestedPath: "../new-note.md",
        resolvedPath: missingPath,
        scope: "outside_workspace",
        exists: false,
        type: "missing",
    });
});

test("reviewer directory facts stop at the fixed metadata bound", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    for (let index = 0; index < 1_001; index += 1) {
        writeFileSync(join(outside, `entry-${index}`), "");
    }

    const facts = await collectReviewerPathFacts(
        workspace,
        {
            id: "bounded-directory",
            name: "write",
            input: { path: "../outside" },
        },
        [pathAction(outside)],
    );

    expect(facts[0]).toMatchObject({
        entryCount: 1_000,
        totalBytes: 0,
        truncated: true,
    });
});

test("reviewer path inspection stops before work when the turn is cancelled", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const controller = new AbortController();
    controller.abort();

    await expect(collectReviewerPathFacts(
        workspace,
        {
            id: "cancelled",
            name: "write",
            input: { path: "../outside.txt", content: "new" },
        },
        [pathAction(join(root, "outside.txt"))],
        controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
});

test("@core reviewer Git facts isolate a clean target in a dirty repository", async () => {
    const repo = repository();
    const target = join(repo, "src", "a.ts");
    const other = join(repo, "other.ts");
    writeFileSync(other, "original\n");
    git(repo, ["add", "other.ts"]);
    git(repo, ["commit", "-q", "-m", "add other"]);
    writeFileSync(other, "changed\n");

    expect(await gitState(repo, target)).toBe("clean");
    git(repo, ["add", "other.ts"]);
    expect(await gitState(repo, target)).toBe("clean");
});

test("@core reviewer Git facts report unstaged and staged changes to the target", async () => {
    const repo = repository();
    const target = join(repo, "src", "a.ts");
    writeFileSync(target, "modified\n");

    expect(await gitState(repo, target)).toBe("dirty");
    git(repo, ["add", "src/a.ts"]);
    expect(await gitState(repo, target)).toBe("dirty");
    git(repo, ["commit", "-q", "-m", "change target"]);
    expect(await gitState(repo, target)).toBe("clean");
});

test("@core reviewer Git facts identify untracked and ignored files", async () => {
    const repo = repository();
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-q", "-m", "ignore a file"]);
    const untracked = join(repo, "new.txt");
    const ignored = join(repo, "ignored.txt");
    writeFileSync(untracked, "new\n");
    writeFileSync(ignored, "ignored\n");

    expect(await gitState(repo, untracked)).toBe("untracked");
    expect(await gitState(repo, ignored)).toBe("untracked");
});

test("@core reviewer Git facts scope directories to their contents", async () => {
    const repo = repository();
    const target = join(repo, "src");
    const outside = join(repo, "other.txt");
    writeFileSync(outside, "original\n");
    git(repo, ["add", "other.txt"]);
    git(repo, ["commit", "-q", "-m", "add other"]);
    writeFileSync(outside, "modified\n");

    expect(await gitState(repo, target)).toBe("clean");
    writeFileSync(join(target, "new.txt"), "new\n");
    expect(await gitState(repo, target)).toBe("untracked");
    writeFileSync(join(target, "a.ts"), "modified\n");
    expect(await gitState(repo, target)).toBe("dirty");
    git(repo, ["add", "src/a.ts"]);
    expect(await gitState(repo, target)).toBe("dirty");
});

test("@core reviewer Git facts use literal pathspecs", async () => {
    const repo = repository();
    const target = join(repo, "file[1].txt");
    const other = join(repo, "file1.txt");
    writeFileSync(target, "original\n");
    writeFileSync(other, "original\n");
    git(repo, ["add", "file[1].txt", "file1.txt"]);
    git(repo, ["commit", "-q", "-m", "add files"]);
    writeFileSync(other, "modified\n");

    expect(await gitState(repo, target)).toBe("clean");
    writeFileSync(target, "modified\n");
    expect(await gitState(repo, target)).toBe("dirty");
});

test("reviewer Git facts report missing tracked targets with changes", async () => {
    const repo = repository();
    const target = join(repo, "src", "a.ts");
    rmSync(target);

    expect(await gitState(repo, target)).toBe("dirty");
    git(repo, ["add", "src/a.ts"]);
    expect(await gitState(repo, target)).toBe("dirty");
});

test("@core reviewer Git facts report Git errors as unavailable", async () => {
    const repo = repository();
    const target = join(repo, "src", "a.ts");
    writeFileSync(join(repo, ".git", "index"), "invalid index");

    expect(await gitState(repo, target)).toBe("unavailable");

    const broken = temporaryDirectory();
    const brokenTarget = join(broken, "file.txt");
    writeFileSync(join(broken, ".git"), "gitdir: missing-git-directory\n");
    writeFileSync(brokenTarget, "content\n");
    expect(await gitState(broken, brokenTarget)).toBe("unavailable");
});

async function gitState(workspace: string, path: string) {
    const [fact] = await collectReviewerPathFacts(
        workspace,
        { id: "git-state", name: "write", input: { path } },
        [],
    );
    return fact?.trackedGitState;
}

function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-review-path-facts-"));
    temporaryDirectories.push(path);
    return path;
}

function pathAction(
    path: string,
    verb: "read" | "write" = "write",
): PermissionActionDecision {
    return {
        action: {
            tool: verb,
            verb,
            path,
            scope: "outside_workspace",
        },
        outcome: "review",
        rule: "profile.default",
    };
}
