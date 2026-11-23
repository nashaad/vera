import { dirname, isAbsolute, resolve } from "node:path";

// The most write roots, and the most read roots, one session may declare.
export const MAX_SESSION_ROOTS = 16;

// Stored roots are canonical absolute directories and never the filesystem
// root. Reading a header does not touch the filesystem, so this checks syntax
// only; creation checks existence and protected paths.
export function isSessionRoot(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && !value.includes("\0")
        && isAbsolute(value)
        && resolve(value) === value
        && dirname(value) !== value;
}

export function isSessionRoots(
    value: unknown,
): value is readonly string[] {
    return Array.isArray(value)
        && value.length <= MAX_SESSION_ROOTS
        && value.every(isSessionRoot);
}
