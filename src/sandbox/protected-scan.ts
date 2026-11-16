import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * srt's `DEFAULT_MANDATORY_DENY_SEARCH_DEPTH`, which its package keeps
 * private. Its scan lists files to this depth plus one, and a dangerous
 * directory must lie one folder shallower than a dangerous file.
 */
export const SEARCH_DEPTH = 3;
const DEFAULT_BUDGET_MS = 2000;

export interface ProtectedScanInput {
    readonly roots: readonly string[];
    readonly protectedFiles: readonly string[];
    readonly protectedDirectories: readonly string[];
    readonly budgetMs?: number;
    readonly now?: () => number;
}

export type ProtectedScanResult =
    | { readonly ok: true; readonly paths: readonly string[] }
    | { readonly ok: false; readonly reason: string };

interface ScannedEntry {
    readonly parts: readonly string[];
}

interface NameMatch {
    readonly at: number;
    readonly length: number;
    readonly directory: boolean;
}

/**
 * Finds the protected names srt's own Linux scan would find, anchored at
 * each root instead of at the folder its process happens to run in. Any
 * failure is a failure: the caller must refuse the command rather than run
 * it with fewer denies than this scan would have produced.
 */
export function scanNestedProtectedPaths(
    input: ProtectedScanInput,
): ProtectedScanResult {
    const now = input.now ?? Date.now;
    const deadline = now() + (input.budgetMs ?? DEFAULT_BUDGET_MS);
    const names = [
        ...input.protectedDirectories.map((name) => name.split("/")),
        [".git", "hooks"],
        [".git", "config"],
        [".git", "HEAD"],
    ];
    const paths = new Set<string>();
    try {
        for (const root of input.roots) {
            const absolute = resolve(root);
            if (!lstatSync(absolute).isDirectory()) {
                throw new Error(`${absolute} is not a folder`);
            }
            for (const entry of walk(absolute, deadline, now, (path) => {
                paths.add(path);
            })) {
                const match = protectedNameAt(entry.parts, names, input.protectedFiles);
                if (match === undefined) continue;
                const deepest = match.directory
                    ? SEARCH_DEPTH - 2
                    : SEARCH_DEPTH - 1;
                if (match.at > deepest) continue;
                const found = entry.parts.slice(0, match.at + match.length);
                if (found.at(-2) === ".git" && found.at(-1) === "HEAD") {
                    found[found.length - 1] = "hooks";
                }
                paths.add(join(absolute, ...found));
            }
        }
    } catch (error) {
        return { ok: false, reason: messageOf(error) };
    }
    return { ok: true, paths: [...paths] };
}

function protectedNameAt(
    parts: readonly string[],
    names: readonly (readonly string[])[],
    protectedFiles: readonly string[],
): NameMatch | undefined {
    for (let at = 0; at < parts.length; at++) {
        for (const name of names) {
            if (name.every((component, offset) => parts[at + offset] === component)) {
                return { at, length: name.length, directory: true };
            }
        }
    }
    const file = parts.at(-1);
    if (file !== undefined && protectedFiles.includes(file)) {
        return { at: parts.length - 1, length: 1, directory: false };
    }
    return undefined;
}

function* walk(
    root: string,
    deadline: number,
    now: () => number,
    deny: (path: string) => void,
): Generator<ScannedEntry> {
    const pending: {
        readonly dir: string;
        readonly parts: readonly string[];
        readonly depth: number;
    }[] = [{ dir: root, parts: [], depth: 0 }];
    while (pending.length > 0) {
        if (now() > deadline) {
            throw new Error("the protected-path scan passed its time limit");
        }
        const { dir, parts, depth } = pending.pop()!;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // A folder that vanished mid-scan holds nothing to protect.
            if (code === "ENOENT" || code === "ENOTDIR") continue;
            // srt denies an unreadable folder whole when it is this user's
            // and no link led to it; another user's folder is skipped.
            if (code === "EACCES" || code === "EPERM") {
                if (unreadableKind(dir) === "deny") deny(dir);
                continue;
            }
            throw error;
        }
        const inGitDirectory = parts.at(-1) === ".git";
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const childParts = [...parts, entry.name];
            yield { parts: childParts };
            if (!entry.isDirectory()) continue;
            if (entry.name === "node_modules") continue;
            if (depth + 1 >= SEARCH_DEPTH + 1) continue;
            // Only a git directory's own entries matter: the names are its
            // hooks, config and HEAD, never anything below those.
            if (inGitDirectory) continue;
            pending.push({ dir: join(dir, entry.name), parts: childParts, depth: depth + 1 });
        }
    }
}

function unreadableKind(dir: string): "deny" | "skip" {
    try {
        const stat = lstatSync(dir);
        if (!stat.isDirectory()) return "skip";
        // The walk never follows a symbolic link, so this path has none on
        // the way. A folder that is not this user's is skipped: nobody else's
        // mode can be given back from inside the sandbox, and there can be
        // many of them, each needing its own mount.
        if (stat.uid !== process.getuid?.()) return "skip";
        return "deny";
    } catch {
        return "skip";
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
