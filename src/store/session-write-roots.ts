import { dirname, isAbsolute, resolve } from "node:path";

export const MAX_SESSION_WRITE_ROOTS = 16;

// Stored roots are canonical absolute directories and never the filesystem
// root. Reading a header does not touch the filesystem, so this checks syntax
// only; creation checks existence and protected paths.
export function isSessionWriteRoot(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && !value.includes("\0")
        && isAbsolute(value)
        && resolve(value) === value
        && dirname(value) !== value;
}

export function isSessionWriteRoots(
    value: unknown,
): value is readonly string[] {
    return Array.isArray(value)
        && value.length <= MAX_SESSION_WRITE_ROOTS
        && value.every(isSessionWriteRoot);
}
