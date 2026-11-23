// The request and reply shapes of the git task. This module holds plain data and
// checks, with no process or filesystem work, so the desktop main process can
// parse the wire without loading the git code.

export type GitScope = "branch" | "uncommitted";
export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";
export type GitPathStatus = GitFileStatus | "ignored";

export interface GitPathEntry {
    readonly path: string;
    readonly ignored: boolean;
    readonly status: GitPathStatus | null;
}

export interface GitSearchResult {
    readonly path: string;
    readonly matches: number;
    readonly firstLine: number;
}

export interface GitBranch {
    readonly name: string;
    readonly remote: boolean;
}

export interface GitState {
    readonly folder: string;
    readonly repo: boolean;
    readonly root: string | null;
    readonly branch: string | null;
    readonly detached: boolean;
    readonly head: string | null;
    readonly hasCommits: boolean;
    readonly branches: readonly GitBranch[];
    // True when the branch list stopped at its cap.
    readonly branchesPartial: boolean;
    readonly upstream: string | null;
    readonly defaultDestination: string | null;
}

export interface GitChangedFile {
    readonly path: string;
    readonly prevPath?: string;
    readonly status: GitFileStatus;
    // Null for binary files and for files whose line count was not read.
    readonly added: number | null;
    readonly removed: number | null;
    readonly binary: boolean;
}

export interface GitFileList {
    readonly base: string;
    readonly destination: string | null;
    readonly files: readonly GitChangedFile[];
    readonly total: number;
    readonly added: number;
    readonly removed: number;
    // True when some file counts were not read, so the totals are a lower bound.
    readonly totalsPartial: boolean;
    readonly noMergeBase: boolean;
}

export interface GitPatchTarget {
    readonly path: string;
    readonly prevPath?: string;
    readonly status: GitFileStatus;
}

export interface GitPatchFile {
    readonly path: string;
    readonly patch: string;
    readonly binary: boolean;
    readonly cut: boolean;
    readonly oldBytes: number | null;
    readonly newBytes: number | null;
}

export interface GitTextSide {
    readonly name: string;
    readonly contents: string;
    readonly cacheKey: string;
}

export interface GitTextFile {
    readonly path: string;
    readonly old: GitTextSide | null;
    readonly new: GitTextSide | null;
    readonly oldTooLarge: boolean;
    readonly newTooLarge: boolean;
}

export interface FileLineChange {
    readonly kind: "added" | "changed" | "removed";
    readonly start: number;
    readonly end: number;
}

export const MAX_FILE_LINE_CHANGES = 500;

export type GitTask =
    | { readonly kind: "state"; readonly folder: string }
    | { readonly kind: "files"; readonly folder: string; readonly scope: GitScope; readonly destination: string | null }
    | {
        readonly kind: "patches";
        readonly folder: string;
        readonly scope: GitScope;
        readonly destination: string | null;
        readonly files: readonly GitPatchTarget[];
    }
    | {
        readonly kind: "texts";
        readonly folder: string;
        readonly scope: GitScope;
        readonly destination: string | null;
        readonly file: GitPatchTarget;
    }
    | { readonly kind: "changedLines"; readonly folder: string; readonly path: string }
    | { readonly kind: "paths"; readonly folder: string }
    | { readonly kind: "search"; readonly folder: string; readonly query: string };

export type GitTaskReply =
    | { readonly kind: "state"; readonly ok: true; readonly state: GitState }
    | { readonly kind: "files"; readonly ok: true; readonly list: GitFileList }
    | { readonly kind: "patches"; readonly ok: true; readonly patches: readonly GitPatchFile[] }
    | { readonly kind: "texts"; readonly ok: true; readonly texts: GitTextFile }
    | { readonly kind: "changedLines"; readonly ok: true; readonly changes: readonly FileLineChange[] | null }
    | { readonly kind: "paths"; readonly ok: true; readonly root: string; readonly paths: readonly GitPathEntry[]; readonly truncated: boolean }
    | { readonly kind: "search"; readonly ok: true; readonly results: readonly GitSearchResult[]; readonly truncated: boolean; readonly timedOut: boolean }
    | { readonly kind: "failure"; readonly ok: false; readonly reason: string };

export const MAX_GIT_FILES = 5_000;
export const MAX_GIT_PATHS = 50_000;
export const MAX_GIT_SEARCH_QUERY = 1_000;
export const MAX_GIT_SEARCH_RESULTS = 5_000;
export const MAX_GIT_SEARCH_MATCHES = 1_000;
export const MAX_GIT_SEARCH_BYTES = 8 * 1024 * 1024;
export const GIT_SEARCH_TIMEOUT_MS = 10_000;
export const MAX_GIT_BRANCHES = 2_000;
export const MAX_PATCH_FILES = 6;
export const MAX_PATCH_LINES = 400;
export const MAX_PATCH_BYTES = 128 * 1024;
export const MAX_PATCH_REPLY_BYTES = 1_000_000;
export const MAX_PATCH_LINE_BYTES = 8 * 1024;
export const MAX_FULL_FILE_BYTES = 400 * 1024;
export const MAX_UNTRACKED_READ_BYTES = 1024 * 1024;
export const MAX_FILE_LIST_READ_BYTES = 8 * 1024 * 1024;

// The folder argument comes from a session. Absolute-only keeps the task from
// reading through a relative path once the desktop has checked it.
export function validAbsolutePath(path: unknown): path is string {
    return typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"));
}

export function validGitFolder(folder: unknown): folder is string {
    return validAbsolutePath(folder) && folder !== "";
}

export function validGitScope(scope: unknown): scope is GitScope {
    return scope === "branch" || scope === "uncommitted";
}

// Paths travel from `git diff -z` back through the renderer. Refuse the ones a
// repository path can never be, so a worktree read cannot leave the root.
export function validGitPath(path: unknown): path is string {
    if (typeof path !== "string" || path === "" || path.includes("\0") || path.startsWith("/")) return false;
    return path.split("/").every((part) => part !== "..");
}

