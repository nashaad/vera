/**
 * A directory's identity for anything Vera stores per workspace.
 *
 * The key is the readable path, not a hash: the point of keying state by
 * workspace is being able to read a directory listing and know which workspace
 * produced what, without a lookup table. `~/Projects/vera` becomes
 * `-Users-nash-Projects-vera`.
 *
 * Two accepted costs. A directory literally named `Projects-vera` flattens the
 * same as `Projects/vera`, so the two would share state. And moving a directory
 * strands whatever was stored under its old key.
 *
 * The key is the working directory itself and never a resolved repository root.
 * Vera is not only a coding agent, so a workspace must not be defined by
 * whether the directory happens to contain a `.git`.
 */
export function workspaceKey(cwd: string): string {
    const flattened = cwd.replace(/[^A-Za-z0-9]+/g, "-");
    return flattened.length === 0 ? "-" : flattened;
}
