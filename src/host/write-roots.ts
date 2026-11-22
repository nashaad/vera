import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, sep } from "node:path";

import { canonicalPermissionPath } from "../engine/workspace-scope.ts";
import { selectedVeraHome } from "../profile-paths.ts";
import { MAX_SESSION_WRITE_ROOTS } from "../store/session-write-roots.ts";
import { UserFacingError } from "../user-facing-error.ts";

// Resolves launch-time write roots to the canonical directories stored in the
// session header. Existence, type and protected paths are checked here; a
// header read later checks syntax only.
export async function resolveSessionWriteRoots(
    roots: readonly string[] | undefined,
): Promise<readonly string[] | undefined> {
    if (roots === undefined || roots.length === 0) {
        return undefined;
    }
    if (roots.length > MAX_SESSION_WRITE_ROOTS) {
        throw new UserFacingError(
            `A session can have at most ${MAX_SESSION_WRITE_ROOTS} write roots.`,
        );
    }
    const home = canonicalPermissionPath(homedir());
    const veraHome = canonicalPermissionPath(selectedVeraHome());
    const resolved = new Set<string>();
    for (const root of roots) {
        resolved.add(await resolveWriteRoot(root, home, veraHome));
    }
    return [...resolved];
}

async function resolveWriteRoot(
    root: string,
    home: string,
    veraHome: string,
): Promise<string> {
    if (root.trim().length === 0) {
        throw new UserFacingError("Write root must not be empty.");
    }
    if (root.includes("\0")) {
        throw new UserFacingError("Write root must be a valid path.");
    }
    if (!isAbsolute(root)) {
        throw new UserFacingError(
            `Write root ${root} must be an absolute path.`,
        );
    }
    let canonical: string;
    try {
        canonical = await realpath(root);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new UserFacingError(`Write root ${root} does not exist.`);
        }
        throw error;
    }
    if (!(await stat(canonical)).isDirectory()) {
        throw new UserFacingError(
            `Write root ${root} is not a directory.`,
        );
    }
    if (dirname(canonical) === canonical) {
        throw new UserFacingError(
            `Write root ${root} is the filesystem root.`,
        );
    }
    if (canonical === home) {
        throw new UserFacingError(
            `Write root ${root} is the home directory.`,
        );
    }
    if (containsPath(canonical, home)) {
        throw new UserFacingError(
            `Write root ${root} contains the home directory.`,
        );
    }
    if (
        containsPath(canonical, veraHome)
        || containsPath(veraHome, canonical)
    ) {
        throw new UserFacingError(
            `Write root ${root} overlaps Vera's home.`,
        );
    }
    return canonical;
}

function containsPath(parent: string, child: string): boolean {
    return child === parent || child.startsWith(`${parent}${sep}`);
}
