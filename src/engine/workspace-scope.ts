import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export type WorkspaceScope = "workspace" | "outside_workspace";

export interface WorkspacePlacement {
    readonly scope: WorkspaceScope;
    // The path is in a checkout other than the workspace's, of the same repository.
    readonly otherWorktree: boolean;
    // An outside path under one of the session's write roots.
    readonly writeRoot: boolean;
}

interface Checkout {
    readonly root: string;
    readonly repository: string;
}

const GIT_FILE_BYTES_LIMIT = 4_096;

export function workspaceScope(path: string, workspace: string): WorkspaceScope {
    return placeInWorkspace(path, workspace).scope;
}

// The git directory a linked worktree shares with its main checkout, or
// undefined for a main checkout and for a submodule, which keeps its own.
// A linked worktree's `.git` is a pointer whose git directory names the
// shared one in `commondir`; a submodule's pointer has none.
export function linkedWorktreeSharedDirectory(
    workspace: string,
): string | undefined {
    const here = checkoutOf(resolve(workspace));
    if (here === undefined) {
        return undefined;
    }
    const gitDirectory = pointerGitDirectory(here.root);
    if (gitDirectory === undefined) {
        return undefined;
    }
    const shared = commonDirectory(gitDirectory);
    return shared === gitDirectory ? undefined : realPath(shared);
}

// Every other checkout of the workspace's repository, read from the shared
// git directory, so a sandbox can deny writes to a worktree nested under the
// workspace root that the workspace allow list would otherwise cover.
export function otherCheckoutRoots(workspace: string): readonly string[] {
    const here = checkoutOf(resolve(workspace));
    if (here === undefined) {
        return [];
    }
    const roots = new Set<string>();
    const main = dirname(here.repository);
    if (main !== here.root) roots.add(main);
    let names: string[];
    try {
        names = readdirSync(join(here.repository, "worktrees"));
    } catch {
        names = [];
    }
    for (const name of names) {
        try {
            const gitdir = readSmallFile(
                join(here.repository, "worktrees", name, "gitdir"),
            ).trim();
            if (gitdir === "") continue;
            const root = dirname(resolve(gitdir));
            if (root !== here.root) roots.add(root);
        } catch {
            // A worktree pruned between readdir and read is already gone.
        }
    }
    return [...roots];
}

// A checkout of the same repository other than the workspace's is outside it,
// even nested under the root. A nested clone or submodule stays inside.
// Write roots are compared in canonical form, so a symlink under a root that
// points elsewhere does not take the root's authority.
export function placeInWorkspace(
    path: string,
    workspace: string,
    writeRoots: readonly string[] = [],
): WorkspacePlacement {
    const root = resolve(workspace);
    const otherWorktree = inOtherWorktree(path, root);
    const inside = path === root || path.startsWith(`${root}${sep}`);
    const scope: WorkspaceScope = inside && !otherWorktree
        ? "workspace"
        : "outside_workspace";
    return {
        scope,
        otherWorktree,
        writeRoot: scope === "outside_workspace"
            && !otherWorktree
            && underWriteRoot(path, writeRoots),
    };
}

// The path the kernel opens: the realpath of the longest existing prefix, with
// the rest appended. On macOS this folds `/tmp` into `/private/tmp` and the
// default volume's case differences.
export function canonicalPermissionPath(path: string): string {
    const normalized = resolve(path);
    const rest: string[] = [];
    let prefix = normalized;
    while (true) {
        try {
            return resolve(realpathSync(prefix), ...rest);
        } catch {
            const parent = dirname(prefix);
            if (parent === prefix) return normalized;
            rest.unshift(basename(prefix));
            prefix = parent;
        }
    }
}

function underWriteRoot(
    path: string,
    writeRoots: readonly string[],
): boolean {
    if (writeRoots.length === 0) return false;
    const canonical = canonicalPermissionPath(path);
    return writeRoots.some((root) =>
        canonical === root || canonical.startsWith(`${root}${sep}`)
    );
}

function inOtherWorktree(path: string, workspace: string): boolean {
    const here = checkoutOf(workspace);
    if (here === undefined) {
        return false;
    }
    const there = checkoutOf(path);
    return there !== undefined
        && there.root !== here.root
        && there.repository === here.repository;
}

// The nearest enclosing checkout, and the git directory all its worktrees share.
function checkoutOf(start: string): Checkout | undefined {
    for (let directory = start; ; directory = dirname(directory)) {
        const repository = repositoryOf(directory);
        if (repository !== undefined) {
            return { root: realPath(directory), repository };
        }
        if (dirname(directory) === directory) {
            return undefined;
        }
    }
}

function pointerGitDirectory(root: string): string | undefined {
    try {
        const marker = join(root, ".git");
        if (!lstatSync(marker).isFile()) {
            return undefined;
        }
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readSmallFile(marker));
        return match === null ? undefined : resolve(root, match[1]!);
    } catch {
        return undefined;
    }
}

function repositoryOf(directory: string): string | undefined {
    const marker = join(directory, ".git");
    try {
        const stat = lstatSync(marker);
        if (stat.isDirectory()) {
            return realPath(marker);
        }
        if (!stat.isFile()) {
            return undefined;
        }
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readSmallFile(marker));
        if (match === null) {
            return undefined;
        }
        const gitDirectory = resolve(directory, match[1]!);
        return realPath(commonDirectory(gitDirectory));
    } catch {
        return undefined;
    }
}

// A linked worktree's git directory names the shared one in `commondir`; a
// submodule's has none and is its own.
function commonDirectory(gitDirectory: string): string {
    try {
        const shared = readSmallFile(join(gitDirectory, "commondir")).trim();
        return shared.length === 0 ? gitDirectory : resolve(gitDirectory, shared);
    } catch {
        return gitDirectory;
    }
}

function readSmallFile(path: string): string {
    return readFileSync(path, "utf8").slice(0, GIT_FILE_BYTES_LIMIT);
}

function realPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}
