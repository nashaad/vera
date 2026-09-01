/** A directory's identity for anything Vera stores per workspace. The key is the readable path, not a hash: the point of keying state by workspace is being able to read a. */
const WORKTREE_SEGMENT = "/.worktrees/";

function flatten(path: string): string {
    const flattened = path.replace(/[^A-Za-z0-9]+/g, "-");
    return flattened.length === 0 ? "-" : flattened;
}

export function workspaceKey(cwd: string): string {
    const split = cwd.lastIndexOf(WORKTREE_SEGMENT);
    if (split === -1) {
        return flatten(cwd);
    }
    const parent = cwd.slice(0, split);
    const worktree = cwd.slice(split + WORKTREE_SEGMENT.length);
    if (worktree.length === 0) {
        return flatten(cwd);
    }
    return `${flatten(parent)}--${flatten(worktree)}`;
}
