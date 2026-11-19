import {
    lstat,
    readdir,
    realpath,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { HookToolCall } from "../sdk/hooks.ts";
import type { PermissionActionDecision } from "./permissions.ts";
import { workspaceScope } from "./workspace-scope.ts";

const MAX_DIRECTORY_ENTRIES = 1_000;
const GIT_CHECK_TIMEOUT_MS = 1_000;
const GIT_ERROR_LIMIT = 1_024;

export type ReviewerPathType =
    | "file"
    | "directory"
    | "symbolic_link"
    | "other"
    | "missing"
    | "unknown";

export interface ReviewerPathFacts {
    readonly requestedPath: string;
    readonly resolvedPath: string;
    readonly scope: "workspace" | "outside_workspace";
    readonly exists: boolean;
    readonly type: ReviewerPathType;
    readonly symlinkTarget?: string;
    readonly entryCount?: number;
    readonly totalBytes?: number;
    readonly truncated?: boolean;
    readonly trackedGitState?:
        | "clean"
        | "dirty"
        | "untracked"
        | "not_repository"
        | "unavailable";
}

interface PathCandidate {
    readonly requestedPath: string;
    readonly absolutePath: string;
}

interface DirectorySummary {
    readonly entryCount: number;
    readonly totalBytes: number;
    readonly truncated: boolean;
}

export async function collectReviewerPathFacts(
    workspace: string,
    toolCall: HookToolCall,
    actions: readonly PermissionActionDecision[],
    signal?: AbortSignal,
): Promise<readonly ReviewerPathFacts[]> {
    const candidates = pathCandidates(workspace, toolCall, actions);
    const facts: ReviewerPathFacts[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        signal?.throwIfAborted();
        if (seen.has(candidate.absolutePath)) {
            continue;
        }
        const fact = await inspectPath(workspace, candidate, signal);
        if (!seen.has(fact.resolvedPath)) {
            seen.add(fact.resolvedPath);
            facts.push(fact);
        }
    }
    return facts;
}

function pathCandidates(
    workspace: string,
    toolCall: HookToolCall,
    actions: readonly PermissionActionDecision[],
): readonly PathCandidate[] {
    const candidates: PathCandidate[] = [];
    const structuredPath = toolCall.input.path;
    if (
        (toolCall.name === "read"
            || toolCall.name === "write"
            || toolCall.name === "edit")
        && typeof structuredPath === "string"
    ) {
        candidates.push({
            requestedPath: structuredPath,
            absolutePath: resolve(workspace, structuredPath),
        });
    }
    for (const decision of actions) {
        const path = decision.action.path;
        if (path !== undefined) {
            candidates.push({
                requestedPath: path,
                absolutePath: resolve(workspace, path),
            });
        }
    }
    return candidates;
}

async function inspectPath(
    workspace: string,
    candidate: PathCandidate,
    signal?: AbortSignal,
): Promise<ReviewerPathFacts> {
    signal?.throwIfAborted();
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
        info = await lstat(candidate.absolutePath);
    } catch (error) {
        if (isMissingPathError(error)) {
            return {
                requestedPath: candidate.requestedPath,
                resolvedPath: candidate.absolutePath,
                scope: pathScope(workspace, candidate.absolutePath),
                exists: false,
                type: "missing",
                trackedGitState: await trackedGitState(
                    dirname(candidate.absolutePath),
                    basename(candidate.absolutePath),
                    signal,
                ),
            };
        }
        return {
            requestedPath: candidate.requestedPath,
            resolvedPath: candidate.absolutePath,
            scope: pathScope(workspace, candidate.absolutePath),
            exists: false,
            type: "unknown",
            trackedGitState: "unavailable",
        };
    }

    const resolvedPath = await resolveExistingPath(candidate.absolutePath);
    const type = pathType(info);
    const base = {
        requestedPath: candidate.requestedPath,
        resolvedPath,
        scope: pathScope(workspace, resolvedPath),
        exists: true,
        type,
        ...(info.isSymbolicLink() ? { symlinkTarget: resolvedPath } : {}),
    } satisfies Omit<ReviewerPathFacts, "trackedGitState">;
    const gitAnchor = info.isDirectory() ? resolvedPath : dirname(resolvedPath);
    const gitPathspec = info.isDirectory() ? "." : basename(resolvedPath);
    const trackedGitStateValue = await trackedGitState(gitAnchor, gitPathspec, signal);

    if (info.isFile()) {
        return {
            ...base,
            totalBytes: info.size,
            trackedGitState: trackedGitStateValue,
        };
    }
    if (info.isDirectory()) {
        const summary = await summarizeDirectory(resolvedPath, signal);
        return {
            ...base,
            ...summary,
            trackedGitState: trackedGitStateValue,
        };
    }
    return {
        ...base,
        trackedGitState: trackedGitStateValue,
    };
}

async function summarizeDirectory(
    path: string,
    signal?: AbortSignal,
): Promise<DirectorySummary> {
    const pending = [path];
    let entryCount = 0;
    let totalBytes = 0;

    try {
        while (pending.length > 0 && entryCount < MAX_DIRECTORY_ENTRIES) {
            signal?.throwIfAborted();
            const current = pending.pop()!;
            const entries = await readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                if (entryCount >= MAX_DIRECTORY_ENTRIES) {
                    return { entryCount, totalBytes, truncated: true };
                }
                entryCount += 1;
                const entryPath = resolve(current, entry.name);
                if (entry.isDirectory()) {
                    pending.push(entryPath);
                } else if (entry.isFile()) {
                    totalBytes += (await lstat(entryPath)).size;
                }
            }
        }
        return {
            entryCount,
            totalBytes,
            truncated: pending.length > 0,
        };
    } catch {
        signal?.throwIfAborted();
        return { entryCount, totalBytes, truncated: true };
    }
}

async function trackedGitState(
    path: string,
    pathspec: string,
    signal?: AbortSignal,
): Promise<ReviewerPathFacts["trackedGitState"]> {
    const inside = await gitCheck(path, [
        "rev-parse",
        "--is-inside-work-tree",
    ], signal);
    if (inside === undefined) {
        return "unavailable";
    }
    if (inside.exitCode !== 0) {
        return inside.error.startsWith(
            "fatal: not a git repository (or any of the parent directories): .git",
        ) ? "not_repository" : "unavailable";
    }
    const working = await gitCheck(
        path,
        ["diff", "--quiet", "--", pathspec],
        signal,
    );
    const staged = await gitCheck(
        path,
        ["diff", "--cached", "--quiet", "--", pathspec],
        signal,
    );
    if (
        working === undefined || staged === undefined
        || (working.exitCode !== 0 && working.exitCode !== 1)
        || (staged.exitCode !== 0 && staged.exitCode !== 1)
    ) {
        return "unavailable";
    }
    if (working.exitCode === 1 || staged.exitCode === 1) {
        return "dirty";
    }
    const untracked = await gitCheck(path, [
        "ls-files",
        "--others",
        "--directory",
        "--error-unmatch",
        "--",
        pathspec,
    ], signal);
    if (untracked?.exitCode === 0) return "untracked";
    if (untracked?.exitCode === 1) return "clean";
    return "unavailable";
}

async function gitCheck(
    path: string,
    args: readonly string[],
    parentSignal?: AbortSignal,
): Promise<{ exitCode: number; error: string } | undefined> {
    parentSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(GIT_CHECK_TIMEOUT_MS);
    const signal = parentSignal === undefined
        ? timeout
        : AbortSignal.any([parentSignal, timeout]);
    try {
        const child = Bun.spawn(["git", "-C", path, "--literal-pathspecs", ...args], {
            stdout: "ignore",
            stderr: "pipe",
            env: { ...process.env, LC_ALL: "C" },
            signal,
        });
        const reader = child.stderr.getReader();
        const decoder = new TextDecoder();
        let error = "";
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (error.length < GIT_ERROR_LIMIT) {
                error += decoder.decode(chunk.value.subarray(0, GIT_ERROR_LIMIT - error.length));
            }
        }
        const exitCode = await child.exited;
        parentSignal?.throwIfAborted();
        return timeout.aborted ? undefined : { exitCode, error };
    } catch {
        parentSignal?.throwIfAborted();
        return undefined;
    }
}

async function resolveExistingPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

function pathType(
    info: Awaited<ReturnType<typeof lstat>>,
): ReviewerPathType {
    if (info.isSymbolicLink()) return "symbolic_link";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
}

function pathScope(
    workspace: string,
    path: string,
): ReviewerPathFacts["scope"] {
    return workspaceScope(path, workspace);
}

function isMissingPathError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && value.code === "ENOENT";
}
