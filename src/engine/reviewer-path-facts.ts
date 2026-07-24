import {
    lstat,
    readdir,
    realpath,
} from "node:fs/promises";
import {
    dirname,
    relative,
    resolve,
    sep,
} from "node:path";

import type { HookToolCall } from "../sdk/hooks.ts";
import type { PermissionActionDecision } from "./permissions.ts";

const MAX_DIRECTORY_ENTRIES = 1_000;
const GIT_CHECK_TIMEOUT_MS = 1_000;

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
    const trackedGitStateValue = await trackedGitState(gitAnchor, signal);

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
    signal?: AbortSignal,
): Promise<ReviewerPathFacts["trackedGitState"]> {
    const inside = await gitExitCode(path, [
        "rev-parse",
        "--is-inside-work-tree",
    ], signal);
    if (inside === undefined) {
        return "unavailable";
    }
    if (inside !== 0) {
        return "not_repository";
    }
    const working = await gitExitCode(path, ["diff", "--quiet"], signal);
    const staged = await gitExitCode(
        path,
        ["diff", "--cached", "--quiet"],
        signal,
    );
    if (working === undefined || staged === undefined) {
        return "unavailable";
    }
    return working === 0 && staged === 0 ? "clean" : "dirty";
}

async function gitExitCode(
    path: string,
    args: readonly string[],
    parentSignal?: AbortSignal,
) {
    parentSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(GIT_CHECK_TIMEOUT_MS);
    const signal = parentSignal === undefined
        ? timeout
        : AbortSignal.any([parentSignal, timeout]);
    try {
        const process = Bun.spawn(["git", "-C", path, ...args], {
            stdout: "ignore",
            stderr: "ignore",
            signal,
        });
        return await process.exited;
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
    const child = relative(workspace, path);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`))
        ? "workspace"
        : "outside_workspace";
}

function isMissingPathError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && value.code === "ENOENT";
}
