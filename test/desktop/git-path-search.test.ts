import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGitTask } from "../../clients/shared/git-changes.ts";
import type { GitTaskReply } from "../../clients/shared/git-wire.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 60_000);

function repository(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-git-paths-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
    return root;
}

function gitReply(reply: GitTaskReply, kind: "paths"): Extract<GitTaskReply, { kind: "paths" }>;
function gitReply(reply: GitTaskReply, kind: "search"): Extract<GitTaskReply, { kind: "search" }>;
function gitReply(reply: GitTaskReply, kind: "paths" | "search"): GitTaskReply {
    expect(reply.kind).toBe(kind);
    expect(reply.ok).toBe(true);
    return reply;
}

test("@core Git paths include tracked, untracked and ignored entries with changed status", async () => {
    const root = repository();
    mkdirSync(join(root, "ignored-dir"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored.txt\nignored-dir/\n");
    writeFileSync(join(root, "tracked space-é.txt"), "tracked\n");
    writeFileSync(join(root, ".DS_Store"), "root metadata\n");
    writeFileSync(join(root, "ignored.txt"), "ignored\n");
    writeFileSync(join(root, "ignored-dir", "child.txt"), "ignored\n");
    execFileSync("git", ["-C", root, "add", ".gitignore", "tracked space-é.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "files"]);
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "inside.txt"), "inside\n");
    writeFileSync(join(nested, ".DS_Store"), "nested metadata\n");
    execFileSync("git", ["-C", root, "add", "nested/inside.txt", "nested/.DS_Store"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "nested"]);
    writeFileSync(join(root, "tracked space-é.txt"), "changed\n");
    writeFileSync(join(root, "new file.txt"), "new\n");
    const allPaths = gitReply(await runGitTask({ kind: "paths", folder: root }), "paths");
    if (allPaths.kind !== "paths") throw new Error("Expected paths reply");
    const byPath = new Map(allPaths.paths.map((entry) => [entry.path, entry]));
    expect(byPath.get("tracked space-é.txt")?.status).toBe("modified");
    expect(byPath.get("new file.txt")?.status).toBe("untracked");
    expect(byPath.get("ignored.txt")).toMatchObject({ ignored: true, status: "ignored" });
    expect(byPath.get("ignored-dir/")).toMatchObject({ ignored: true, status: "ignored" });
    expect(byPath.has("ignored-dir/child.txt")).toBe(false);
    expect(byPath.has(".DS_Store")).toBe(false);
    expect(byPath.has("nested/.DS_Store")).toBe(false);
    const nestedSearch = gitReply(await runGitTask({ kind: "search", folder: nested, query: "inside" }), "search");
    if (nestedSearch.kind !== "search") throw new Error("Expected search reply");
    expect(nestedSearch.results).toEqual([{ path: "inside.txt", matches: 1, firstLine: 1 }]);
    const reply = gitReply(await runGitTask({ kind: "paths", folder: nested }), "paths");
    if (reply.kind !== "paths") throw new Error("Expected paths reply");
    expect(reply.paths).toEqual([{ path: "inside.txt", ignored: false, status: null }]);
    expect(reply.truncated).toBe(false);
    expect(reply.root).toBe(nested);
});

test("@core Git content search counts lines and treats regex characters literally", async () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "Alpha.*\nalpha.*\nother\nÉtage\nétage\n");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "tracked"]);
    writeFileSync(join(root, "new.txt"), "alpha.*\nalpha.*\n");
    writeFileSync(join(root, "ignored.txt"), "alpha.*\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 97, 108, 112, 104, 97]));

    const insensitive = gitReply(await runGitTask({ kind: "search", folder: root, query: "alpha.*" }), "search");
    if (insensitive.kind !== "search") throw new Error("Expected search reply");
    expect(insensitive.results).toEqual([
        { path: "new.txt", matches: 2, firstLine: 1 },
        { path: "tracked.txt", matches: 2, firstLine: 1 },
    ]);
    const sensitive = gitReply(await runGitTask({ kind: "search", folder: root, query: "Alpha.*" }), "search");
    if (sensitive.kind !== "search") throw new Error("Expected search reply");
    expect(sensitive.results).toEqual([{ path: "tracked.txt", matches: 1, firstLine: 1 }]);
    const unicodeUppercase = gitReply(await runGitTask({ kind: "search", folder: root, query: "Étage" }), "search");
    if (unicodeUppercase.kind !== "search") throw new Error("Expected search reply");
    expect(unicodeUppercase.results).toEqual([{ path: "tracked.txt", matches: 1, firstLine: 4 }]);
    expect(sensitive.timedOut).toBe(false);
});

test("@core Git search returns bounded results when grep output exceeds eight MiB", async () => {
    const root = repository();
    writeFileSync(join(root, "large.txt"), `needle ${"x".repeat(9 * 1024 * 1024)}`);
    const reply = gitReply(await runGitTask({ kind: "search", folder: root, query: "needle" }), "search");
    if (reply.kind !== "search") throw new Error("Expected search reply");
    expect(reply.results.length).toBe(1);
    expect(reply.results[0]?.path).toBe("large.txt");
    expect(reply.results[0]?.matches).toBe(1);
    expect(reply.truncated).toBe(true);
    expect(reply.timedOut).toBe(false);
}, 20_000);

test("Git path list is capped above fifty thousand entries", async () => {
    const root = repository();
    const many = join(root, "many");
    mkdirSync(many);
    for (let index = 0; index < 50_005; index += 1) {
        writeFileSync(join(many, `file-${index}.txt`), "x");
    }
    const reply = gitReply(await runGitTask({ kind: "paths", folder: root }), "paths");
    if (reply.kind !== "paths") throw new Error("Expected paths reply");
    expect(reply.paths.length).toBe(50_000);
    expect(reply.truncated).toBe(true);
}, 60_000);

test("@core Git path and search tasks report a non-repository as a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-not-git-"));
    roots.push(root);
    expect((await runGitTask({ kind: "paths", folder: root })).ok).toBe(false);
    expect((await runGitTask({ kind: "search", folder: root, query: "needle" })).ok).toBe(false);
});
