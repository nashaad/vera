import { expect, test } from "bun:test";

import { GIT_TASK_FILE, GIT_TASK_SERVICE, parseGitTask, parseGitTaskReply } from "../../clients/desktop/src/git/task-protocol.ts";
import { MAX_PATCH_BYTES, type GitTask, type GitTaskReply } from "../../clients/shared/git-wire.ts";

const roundTrip = <Value>(value: Value): unknown => JSON.parse(JSON.stringify(structuredClone(value)));

const TASKS: readonly GitTask[] = [
    { kind: "state", folder: "/work/repo" },
    { kind: "files", folder: "/work/repo", scope: "branch", destination: "main" },
    { kind: "files", folder: "/work/repo", scope: "uncommitted", destination: null },
    { kind: "patches", folder: "/work/repo", scope: "branch", destination: "origin/main", files: [{ path: "a.ts", status: "modified" }, { path: "new.ts", prevPath: "old.ts", status: "renamed" }] },
    { kind: "texts", folder: "/work/repo", scope: "uncommitted", destination: null, file: { path: "a.ts", status: "modified" } },
    { kind: "changedLines", folder: "/work/repo", path: "a.ts" },
    { kind: "paths", folder: "/work/repo" },
    { kind: "search", folder: "/work/repo", query: "literal.*" },
];

const STATE: GitTaskReply = {
    kind: "state",
    ok: true,
    state: {
        folder: "/work/repo",
        repo: true,
        root: "/work/repo",
        branch: "feature",
        detached: false,
        head: "0123456789abcdef0123456789abcdef01234567",
        hasCommits: true,
        branches: [{ name: "main", remote: false }, { name: "origin/main", remote: true }],
        branchesPartial: false,
        upstream: "origin/main",
        defaultDestination: "origin/main",
    },
};

const LIST: GitTaskReply = {
    kind: "files",
    ok: true,
    list: {
        base: "0123456789abcdef0123456789abcdef01234567",
        destination: "main",
        files: [
            { path: "a.ts", status: "modified", added: 2, removed: 1, binary: false },
            { path: "blob.bin", status: "added", added: null, removed: null, binary: true },
            { path: "new.ts", prevPath: "old.ts", status: "renamed", added: 0, removed: 0, binary: false },
        ],
        total: 3,
        added: 2,
        removed: 1,
        totalsPartial: false,
        noMergeBase: false,
    },
};

const PATCHES: GitTaskReply = {
    kind: "patches",
    ok: true,
    patches: [{
        path: "a.ts",
        patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        binary: false,
        cut: false,
        oldBytes: 4,
        newBytes: 4,
    }],
};

const LINE_CHANGES: GitTaskReply = { kind: "changedLines", ok: true, changes: [{ kind: "changed", start: 2, end: 3 }, { kind: "removed", start: 5, end: 5 }] };
const PATHS: GitTaskReply = { kind: "paths", ok: true, root: "/work/repo", paths: [{ path: "folder/", ignored: true, status: "ignored" }, { path: "a.ts", ignored: false, status: "modified" }], truncated: false };
const SEARCH: GitTaskReply = { kind: "search", ok: true, results: [{ path: "a.ts", matches: 2, firstLine: 3 }], truncated: false, timedOut: false };

const TEXTS: GitTaskReply = {
    kind: "texts",
    ok: true,
    texts: {
        path: "a.ts",
        old: { name: "a.ts", contents: "old\n", cacheKey: "git:base:a.ts" },
        new: { name: "a.ts", contents: "new\n", cacheKey: "git:HEAD:a.ts" },
        oldTooLarge: false,
        newTooLarge: false,
    },
};

test("@core every git task and reply survives a structured clone and JSON unchanged", () => {
    for (const task of TASKS) {
        expect(parseGitTask(roundTrip(task))).toEqual(task);
        expect(parseGitTask(task)).toEqual(task);
    }
    for (const reply of [STATE, LIST, PATCHES, TEXTS, LINE_CHANGES, PATHS, SEARCH, { kind: "changedLines", ok: true, changes: null } satisfies GitTaskReply, { kind: "failure", ok: false, reason: "Could not read the changes." } satisfies GitTaskReply]) {
        expect(parseGitTaskReply(roundTrip(reply))).toEqual(reply);
    }
    expect(GIT_TASK_FILE).toBe("git.cjs");
    expect(GIT_TASK_SERVICE).toBe("Vera Git");
});

test("@core malformed git tasks and replies are refused", () => {
    const badTasks: unknown[] = [
        undefined,
        null,
        "state",
        {},
        { kind: "state", folder: "relative/path" },
        { kind: "state", folder: "" },
        { kind: "files", folder: "/repo", scope: "staged", destination: null },
        { kind: "files", folder: "/repo", scope: "branch", destination: "" },
        { kind: "files", folder: "/repo", scope: "branch", destination: "--help" },
        { kind: "files", folder: "/repo", scope: "branch", destination: "-x" },
        { kind: "patches", folder: "/repo", scope: "branch", destination: "main", files: [] },
        { kind: "patches", folder: "/repo", scope: "branch", destination: "main", files: Array.from({ length: 7 }, (_, index) => ({ path: `f${index}.ts`, status: "modified" })) },
        { kind: "patches", folder: "/repo", scope: "branch", destination: "main", files: [{ path: "../a.ts", status: "modified" }] },
        { kind: "patches", folder: "/repo", scope: "branch", destination: "main", files: [{ path: "/a.ts", status: "modified" }] },
        { kind: "texts", folder: "/repo", scope: "branch", destination: "main", file: { path: "a.ts", status: "copied" } },
        { kind: "changedLines", folder: "/repo", path: "../escape" },
        { kind: "changedLines", folder: "/repo", path: "x".repeat(4_097) },
        { kind: "search", folder: "/repo", query: "x".repeat(1_001) },
    ];
    for (const value of badTasks) expect(parseGitTask(value)).toBeUndefined();

    const badReplies: unknown[] = [
        undefined,
        {},
        { kind: "state", ok: true, state: { ...STATE.kind === "state" ? STATE.state : {}, branchesPartial: "no" } },
        { kind: "files", ok: true, list: { ...LIST.kind === "files" ? LIST.list : {}, total: -1 } },
        { kind: "patches", ok: true, patches: [{ path: "a.ts", patch: "x".repeat(MAX_PATCH_BYTES + 1), binary: false, cut: false, oldBytes: null, newBytes: null }] },
        { kind: "texts", ok: true, texts: { path: "a.ts", old: null, new: null, oldTooLarge: false } },
        { kind: "failure", ok: true, reason: "no" },
        { kind: "changedLines", ok: true, changes: [{ kind: "removed", start: 0, end: 0 }] },
        { kind: "paths", ok: true, root: "/repo", paths: [{ path: "../escape", ignored: false, status: null }], truncated: false },
        { kind: "search", ok: true, results: [{ path: "a.ts", matches: 1_001, firstLine: 1 }], truncated: false, timedOut: false },
    ];
    for (const value of badReplies) expect(parseGitTaskReply(value)).toBeUndefined();
});
