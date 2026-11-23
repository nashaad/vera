import {
    MAX_GIT_BRANCHES,
    MAX_GIT_FILES,
    MAX_GIT_PATHS,
    MAX_GIT_SEARCH_QUERY,
    MAX_GIT_SEARCH_RESULTS,
    MAX_GIT_SEARCH_MATCHES,
    MAX_PATCH_FILES,
    MAX_PATCH_BYTES,
    MAX_PATCH_REPLY_BYTES,
    validAbsolutePath,
    validGitFolder,
    validGitPath,
    validGitScope,
    type GitBranch,
    type GitChangedFile,
    type GitFileList,
    type GitFileStatus,
    type GitPathEntry,
    type GitSearchResult,
    type GitPatchFile,
    type GitPatchTarget,
    type GitState,
    type GitTask,
    type GitTaskReply,
    type GitTextFile,
    type GitTextSide,
    MAX_FILE_LINE_CHANGES,
    type FileLineChange,
} from "../../../shared/git-wire.ts";

// The main process imports only this file from this folder; the rest is git code for the task process.

export const GIT_TASK_SERVICE = "Vera Git";
export const GIT_TASK_FILE = "git.cjs";

const STATUSES: readonly GitFileStatus[] = ["added", "modified", "deleted", "renamed", "untracked"];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is GitFileStatus {
    return isString(value) && (STATUSES as readonly string[]).includes(value);
}

// A leading dash would reach rev-parse or merge-base as an option, and git refuses such a branch name too.
function isBranchName(value: unknown): value is string {
    return isString(value) && value !== "" && !value.startsWith("-") && !value.includes("\0");
}

function parseTarget(value: unknown): GitPatchTarget | undefined {
    if (!isRecord(value) || !validGitPath(value.path) || !isStatus(value.status)) return undefined;
    if (value.prevPath !== undefined && !validGitPath(value.prevPath)) return undefined;
    return {
        path: value.path,
        ...(value.prevPath === undefined ? {} : { prevPath: value.prevPath }),
        status: value.status,
    };
}

export function parseGitTask(value: unknown): GitTask | undefined {
    if (!isRecord(value) || !validGitFolder(value.folder)) return undefined;
    if (value.kind === "state") return { kind: "state", folder: value.folder };
    if (value.kind === "changedLines") {
        return validGitPath(value.path) && value.path.length <= 4_096 ? { kind: "changedLines", folder: value.folder, path: value.path } : undefined;
    }
    if (value.kind === "paths") return { kind: "paths", folder: value.folder };
    if (value.kind === "search") {
        return isString(value.query) && value.query.length <= MAX_GIT_SEARCH_QUERY
            ? { kind: "search", folder: value.folder, query: value.query }
            : undefined;
    }
    if (!validGitScope(value.scope)) return undefined;
    if (value.destination !== null && !isBranchName(value.destination)) return undefined;
    if (value.kind === "files") {
        return { kind: "files", folder: value.folder, scope: value.scope, destination: value.destination };
    }
    if (value.kind === "patches") {
        if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_PATCH_FILES) return undefined;
        const files: GitPatchTarget[] = [];
        for (const entry of value.files) {
            const target = parseTarget(entry);
            if (target === undefined) return undefined;
            files.push(target);
        }
        return { kind: "patches", folder: value.folder, scope: value.scope, destination: value.destination, files };
    }
    if (value.kind === "texts") {
        const file = parseTarget(value.file);
        return file === undefined
            ? undefined
            : { kind: "texts", folder: value.folder, scope: value.scope, destination: value.destination, file };
    }
    return undefined;
}

function parseBranch(value: unknown): GitBranch | undefined {
    if (!isRecord(value) || !isBranchName(value.name) || typeof value.remote !== "boolean") return undefined;
    return { name: value.name, remote: value.remote };
}

function parseState(value: unknown): GitState | undefined {
    if (!isRecord(value) || !validGitFolder(value.folder)) return undefined;
    const { repo, root, branch, detached, head, hasCommits, branches, branchesPartial, upstream, defaultDestination } = value;
    if (typeof repo !== "boolean" || typeof detached !== "boolean" || typeof hasCommits !== "boolean") return undefined;
    if (typeof branchesPartial !== "boolean") return undefined;
    if (root !== null && !validAbsolutePath(root)) return undefined;
    if (branch !== null && !isBranchName(branch)) return undefined;
    if (head !== null && !isString(head)) return undefined;
    if (upstream !== null && !isBranchName(upstream)) return undefined;
    if (defaultDestination !== null && !isBranchName(defaultDestination)) return undefined;
    if (!Array.isArray(branches) || branches.length > MAX_GIT_BRANCHES) return undefined;
    const parsed: GitBranch[] = [];
    for (const entry of branches) {
        const found = parseBranch(entry);
        if (found === undefined) return undefined;
        parsed.push(found);
    }
    return { folder: value.folder, repo, root, branch, detached, head, hasCommits, branches: parsed, branchesPartial, upstream, defaultDestination };
}

function parseChangedFile(value: unknown): GitChangedFile | undefined {
    if (!isRecord(value) || !validGitPath(value.path) || !isStatus(value.status)) return undefined;
    if (value.prevPath !== undefined && !validGitPath(value.prevPath)) return undefined;
    if (value.added !== null && !isCount(value.added)) return undefined;
    if (value.removed !== null && !isCount(value.removed)) return undefined;
    if (typeof value.binary !== "boolean") return undefined;
    return {
        path: value.path,
        ...(value.prevPath === undefined ? {} : { prevPath: value.prevPath }),
        status: value.status,
        added: value.added,
        removed: value.removed,
        binary: value.binary,
    };
}

function parseFileList(value: unknown): GitFileList | undefined {
    if (!isRecord(value) || !isString(value.base)) return undefined;
    if (value.destination !== null && !isBranchName(value.destination)) return undefined;
    if (!Array.isArray(value.files) || value.files.length > MAX_GIT_FILES) return undefined;
    if (!isCount(value.total) || !isCount(value.added) || !isCount(value.removed)) return undefined;
    if (typeof value.totalsPartial !== "boolean" || typeof value.noMergeBase !== "boolean") return undefined;
    const files: GitChangedFile[] = [];
    for (const entry of value.files) {
        const found = parseChangedFile(entry);
        if (found === undefined) return undefined;
        files.push(found);
    }
    return {
        base: value.base,
        destination: value.destination,
        files,
        total: value.total,
        added: value.added,
        removed: value.removed,
        totalsPartial: value.totalsPartial,
        noMergeBase: value.noMergeBase,
    };
}

function parsePatchFile(value: unknown): GitPatchFile | undefined {
    if (!isRecord(value) || !validGitPath(value.path)) return undefined;
    if (!isString(value.patch) || Buffer.byteLength(value.patch) > MAX_PATCH_BYTES) return undefined;
    if (typeof value.binary !== "boolean" || typeof value.cut !== "boolean") return undefined;
    if (value.oldBytes !== null && !isCount(value.oldBytes)) return undefined;
    if (value.newBytes !== null && !isCount(value.newBytes)) return undefined;
    return {
        path: value.path,
        patch: value.patch,
        binary: value.binary,
        cut: value.cut,
        oldBytes: value.oldBytes,
        newBytes: value.newBytes,
    };
}

function parseTextSide(value: unknown): GitTextSide | undefined {
    if (!isRecord(value) || !validGitPath(value.name)) return undefined;
    if (!isString(value.contents) || !isString(value.cacheKey)) return undefined;
    return { name: value.name, contents: value.contents, cacheKey: value.cacheKey };
}

function parseTextFile(value: unknown): GitTextFile | undefined {
    if (!isRecord(value) || !validGitPath(value.path)) return undefined;
    const oldSide = value.old === null ? null : parseTextSide(value.old);
    const newSide = value.new === null ? null : parseTextSide(value.new);
    if (value.old !== null && oldSide === undefined) return undefined;
    if (value.new !== null && newSide === undefined) return undefined;
    if (typeof value.oldTooLarge !== "boolean" || typeof value.newTooLarge !== "boolean") return undefined;
    return {
        path: value.path,
        old: oldSide ?? null,
        new: newSide ?? null,
        oldTooLarge: value.oldTooLarge,
        newTooLarge: value.newTooLarge,
    };
}

function parsePathEntry(value: unknown): GitPathEntry | undefined {
    if (!isRecord(value) || !validGitPath(value.path) || typeof value.ignored !== "boolean") return undefined;
    if (value.status !== null && value.status !== "ignored" && !isStatus(value.status)) return undefined;
    return { path: value.path, ignored: value.ignored, status: value.status as GitPathEntry["status"] };
}

function parseSearchResult(value: unknown): GitSearchResult | undefined {
    if (!isRecord(value) || !validGitPath(value.path) || !isCount(value.matches) || value.matches > MAX_GIT_SEARCH_MATCHES) return undefined;
    if (!Number.isSafeInteger(value.firstLine) || (value.firstLine as number) < 1) return undefined;
    return { path: value.path, matches: value.matches, firstLine: value.firstLine as number };
}

function parseFileLineChange(value: unknown): FileLineChange | undefined {
    if (!isRecord(value) || (value.kind !== "added" && value.kind !== "changed" && value.kind !== "removed")) return undefined;
    if (!Number.isSafeInteger(value.start) || (value.start as number) < 1) return undefined;
    if (!Number.isSafeInteger(value.end) || (value.end as number) < (value.start as number)) return undefined;
    return { kind: value.kind, start: value.start as number, end: value.end as number };
}

export function parseGitTaskReply(value: unknown): GitTaskReply | undefined {
    if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
    if (value.ok === false) {
        return value.kind === "failure" && isString(value.reason) ? { kind: "failure", ok: false, reason: value.reason } : undefined;
    }
    if (value.kind === "state") {
        const state = parseState(value.state);
        return state === undefined ? undefined : { kind: "state", ok: true, state };
    }
    if (value.kind === "files") {
        const list = parseFileList(value.list);
        return list === undefined ? undefined : { kind: "files", ok: true, list };
    }
    if (value.kind === "patches") {
        if (!Array.isArray(value.patches) || value.patches.length > MAX_PATCH_FILES) return undefined;
        const patches: GitPatchFile[] = [];
        let bytes = 0;
        for (const entry of value.patches) {
            const found = parsePatchFile(entry);
            if (found === undefined) return undefined;
            bytes += Buffer.byteLength(found.patch);
            if (bytes > MAX_PATCH_REPLY_BYTES) return undefined;
            patches.push(found);
        }
        return { kind: "patches", ok: true, patches };
    }
    if (value.kind === "texts") {
        const texts = parseTextFile(value.texts);
        return texts === undefined ? undefined : { kind: "texts", ok: true, texts };
    }
    if (value.kind === "paths") {
        if (!validAbsolutePath(value.root) || !Array.isArray(value.paths) || value.paths.length > MAX_GIT_PATHS || typeof value.truncated !== "boolean") return undefined;
        const paths: GitPathEntry[] = [];
        for (const entry of value.paths) {
            const path = parsePathEntry(entry);
            if (path === undefined) return undefined;
            paths.push(path);
        }
        return { kind: "paths", ok: true, root: value.root, paths, truncated: value.truncated };
    }
    if (value.kind === "search") {
        if (!Array.isArray(value.results) || value.results.length > MAX_GIT_SEARCH_RESULTS || typeof value.truncated !== "boolean" || typeof value.timedOut !== "boolean") return undefined;
        const results: GitSearchResult[] = [];
        for (const entry of value.results) {
            const result = parseSearchResult(entry);
            if (result === undefined) return undefined;
            results.push(result);
        }
        return { kind: "search", ok: true, results, truncated: value.truncated, timedOut: value.timedOut };
    }
    if (value.kind === "changedLines") {
        if (value.changes === null) return { kind: "changedLines", ok: true, changes: null };
        if (!Array.isArray(value.changes) || value.changes.length > MAX_FILE_LINE_CHANGES) return undefined;
        const changes: FileLineChange[] = [];
        for (const entry of value.changes) {
            const change = parseFileLineChange(entry);
            if (change === undefined) return undefined;
            changes.push(change);
        }
        return { kind: "changedLines", ok: true, changes };
    }
    return undefined;
}
