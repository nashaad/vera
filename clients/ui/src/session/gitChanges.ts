import type { FileDiffMetadata } from "@pierre/diffs";

import { MAX_PATCH_FILES, type GitChangedFile, type GitFileList, type GitPatchFile, type GitScope, type GitState } from "../../../shared/git-wire.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { capDiff } from "./diff/cap.ts";
import { parseKeyedPatches, type KeyedPatch } from "./diff/patches.ts";

// The tree draws every changed file under one root, as the reference shows.
export const CHANGED_FILES_ROOT = "Changed files";
// A tab keeps this many parsed patches, and this many bytes of patch text, then drops the oldest.
export const MAX_CACHED_PATCH_FILES = 200;
export const MAX_CACHED_PATCH_BYTES = 8 * 1024 * 1024;
// Past either count the pane shows one file at a time from the start.
export const LARGE_CHANGES_FILES = 100;
export const LARGE_CHANGES_LINES = 5_000;
export const INITIAL_PATCH_FILES = MAX_PATCH_FILES;
export const MORE_PATCH_FILES = MAX_PATCH_FILES;

export interface CachedPatch {
    readonly key: string;
    readonly source: KeyedPatch;
    readonly diff: FileDiffMetadata;
    readonly cut: boolean;
    readonly binary: boolean;
    readonly bytes: number;
}

export type GitRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function failure(reason: string): { readonly ok: false; readonly reason: string } {
    return { ok: false, reason };
}

export async function readGitState(bridge: DesktopBridge, folder: string): Promise<GitRead<GitState>> {
    const reply = await bridge.gitRead({ kind: "state", folder });
    return reply.kind === "state" && reply.ok ? { ok: true, value: reply.state } : failure(reply.ok ? "Could not read the changes." : reply.reason);
}

export async function readGitFiles(
    bridge: DesktopBridge,
    folder: string,
    scope: GitScope,
    destination: string | null,
): Promise<GitRead<GitFileList>> {
    const reply = await bridge.gitRead({ kind: "files", folder, scope, destination });
    return reply.kind === "files" && reply.ok ? { ok: true, value: reply.list } : failure(reply.ok ? "Could not read the changes." : reply.reason);
}

export async function readGitPatches(
    bridge: DesktopBridge,
    folder: string,
    scope: GitScope,
    destination: string | null,
    files: readonly GitChangedFile[],
): Promise<GitRead<readonly GitPatchFile[]>> {
    const reply = await bridge.gitRead({
        kind: "patches",
        folder,
        scope,
        destination,
        files: files.map((file) => ({
            path: file.path,
            status: file.status,
            ...(file.prevPath === undefined ? {} : { prevPath: file.prevPath }),
        })),
    });
    return reply.kind === "patches" && reply.ok ? { ok: true, value: reply.patches } : failure(reply.ok ? "Could not read the changes." : reply.reason);
}

export async function readGitTexts(
    bridge: DesktopBridge,
    folder: string,
    scope: GitScope,
    destination: string | null,
    file: GitChangedFile,
) {
    return await bridge.gitRead({
        kind: "texts",
        folder,
        scope,
        destination,
        file: {
            path: file.path,
            status: file.status,
            ...(file.prevPath === undefined ? {} : { prevPath: file.prevPath }),
        },
    });
}

export function gitPatchKey(scope: GitScope, base: string, path: string): string {
    return `git:${scope}:${base}:${path}`;
}

export function parseGitPatch(patch: GitPatchFile, scope: GitScope, base: string, path: string, prevPath?: string): CachedPatch | undefined {
    const key = gitPatchKey(scope, base, path);
    const source = parseKeyedPatches([patch.patch], [key])[0];
    if (source?.diff === undefined) return undefined;
    const named: FileDiffMetadata = {
        ...source.diff,
        name: path,
        ...(prevPath === undefined ? {} : { prevName: prevPath }),
    };
    const capped = capDiff(named);
    return {
        key,
        source: { ...source, diff: named },
        diff: capped.diff,
        cut: patch.cut || capped.cut,
        binary: patch.binary,
        bytes: patch.patch.length,
    };
}

export function needsOneFile(list: GitFileList): boolean {
    return list.total > LARGE_CHANGES_FILES || list.added + list.removed > LARGE_CHANGES_LINES;
}

export function splitChangePath(path: string): { readonly folder: string; readonly name: string } {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? { folder: "", name: path } : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

// Mirrors @pierre/trees: folders before files, then lowercased natural names,
// with raw names breaking case ties. The diff and one-file navigation use it.
function segmentTokens(value: string): readonly (string | number)[] {
    const tokens: (string | number)[] = [];
    let index = 0;
    while (index < value.length) {
        const start = index;
        const digit = (code: number): boolean => code >= 48 && code <= 57;
        if (digit(value.charCodeAt(index))) {
            let number = 0;
            while (index < value.length && digit(value.charCodeAt(index))) {
                number = number * 10 + (value.charCodeAt(index) - 48);
                index += 1;
            }
            tokens.push(number);
        } else {
            while (index < value.length && !digit(value.charCodeAt(index))) index += 1;
            tokens.push(value.slice(start, index));
        }
    }
    return tokens;
}

function compareSegments(left: string, right: string): number {
    const lowerLeft = left.toLowerCase();
    const lowerRight = right.toLowerCase();
    const leftTokens = segmentTokens(lowerLeft);
    const rightTokens = segmentTokens(lowerRight);
    const shared = Math.min(leftTokens.length, rightTokens.length);
    for (let index = 0; index < shared; index += 1) {
        const leftToken = leftTokens[index]!;
        const rightToken = rightTokens[index]!;
        if (leftToken === rightToken) continue;
        if (typeof leftToken === "number" && typeof rightToken === "number") return leftToken < rightToken ? -1 : 1;
        const leftText = String(leftToken);
        const rightText = String(rightToken);
        if (leftText !== rightText) return leftText < rightText ? -1 : 1;
    }
    if (leftTokens.length !== rightTokens.length) return leftTokens.length < rightTokens.length ? -1 : 1;
    if (lowerLeft === lowerRight) {
        if (left === right) return 0;
        return left < right ? -1 : 1;
    }
    return lowerLeft < lowerRight ? -1 : 1;
}

export function compareTreePaths(left: string, right: string): number {
    const leftParts = left.split("/");
    const rightParts = right.split("/");
    const shared = Math.min(leftParts.length, rightParts.length);
    for (let index = 0; index < shared; index += 1) {
        if (leftParts[index] === rightParts[index]) continue;
        const leftFolder = index < leftParts.length - 1;
        const rightFolder = index < rightParts.length - 1;
        if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
        return compareSegments(leftParts[index]!, rightParts[index]!);
    }
    return leftParts.length - rightParts.length;
}

export function treeOrderedFiles(files: readonly GitChangedFile[]): GitChangedFile[] {
    return [...files].sort((left, right) => compareTreePaths(left.path, right.path));
}

export function treeStatus(file: GitChangedFile): "added" | "deleted" | "modified" | "renamed" | "untracked" {
    return file.status;
}

export function patchTargets(files: readonly GitChangedFile[], paths: ReadonlySet<string>): readonly GitChangedFile[] {
    return files.filter((file) => paths.has(file.path));
}
