/**
 * A directory's identity for anything Vera stores per workspace.
 *
 * The key is the readable path, not a hash: the point of keying state by
 * workspace is being able to read a directory listing and know which workspace
 * produced what, without a lookup table. `/Users/you/Projects/app` becomes
 * `-Users-you-Projects-app`.
 *
 * A checkout under `.worktrees` keys as its parent, a `--` join, and the
 * worktree name: `/Users/you/Projects/app/.worktrees/fix` becomes
 * `-Users-you-Projects-app--fix`. The split is lexical and never asks git,
 * because Vera is not only a coding agent and a workspace must not be defined
 * by whether the directory happens to contain a `.git`.
 *
 * Two accepted costs. A directory literally named `Projects-app` flattens the
 * same as `Projects/app`, so the two would share state. And moving a directory
 * strands whatever was stored under its old key.
 *
 * The key is the working directory itself and never a resolved repository root.
 */
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
    // Each side flattens on its own, so the join is the only `--` a key can
    // hold: a run of separators anywhere else collapses to a single dash.
    return `${flatten(parent)}--${flatten(worktree)}`;
}
