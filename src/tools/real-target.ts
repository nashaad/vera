import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const MAX_SYMLINKS = 40;

// Walks the path the way the kernel opens it. `realpath` is not used because
// it settles `..` before following links, so `link/..` would stay put.
export async function resolveRealTarget(
    requestedPath: string,
): Promise<string | undefined> {
    if (!isAbsolute(requestedPath)) {
        return undefined;
    }
    const pending = requestedPath.split(sep).reverse();
    let current: string = sep;
    let links = 0;
    while (pending.length > 0) {
        const part = pending.pop()!;
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            current = dirname(current);
            continue;
        }
        const next = join(current, part);
        const kind = await entryKind(next);
        if (kind === "error") {
            return undefined;
        }
        if (kind === "missing") {
            const rest = pending.reverse();
            // Once a folder is missing, a `..` after it could climb back
            // into a link, so the rest cannot be read as plain names.
            return rest.includes("..") ? undefined : resolve(next, ...rest);
        }
        if (kind === "symlink") {
            links += 1;
            const target = links > MAX_SYMLINKS
                ? undefined
                : await readLinkTarget(next);
            if (target === undefined) {
                return undefined;
            }
            pending.push(...target.split(sep).reverse());
            if (isAbsolute(target)) {
                current = sep;
            }
            continue;
        }
        current = next;
    }
    return current;
}

export async function resolveRealTargets(
    requestedPaths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
    const resolved = new Map<string, string>();
    for (const requested of new Set(requestedPaths)) {
        const real = await resolveRealTarget(requested);
        if (real !== undefined) {
            resolved.set(requested, real);
        }
    }
    return resolved;
}

async function entryKind(
    path: string,
): Promise<"symlink" | "entry" | "missing" | "error"> {
    try {
        const stats = await lstat(path);
        return stats.isSymbolicLink() ? "symlink" : "entry";
    } catch (error) {
        return isMissingPathError(error) ? "missing" : "error";
    }
}

async function readLinkTarget(path: string): Promise<string | undefined> {
    try {
        return await readlink(path);
    } catch {
        return undefined;
    }
}

function isMissingPathError(value: unknown): boolean {
    return value instanceof Error
        && "code" in value
        && value.code === "ENOENT";
}
