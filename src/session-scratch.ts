import { lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { selectedVeraHome, veraRuntimeDirectoryIn } from "./profile-paths.ts";

export function sessionScratchRoot(home = selectedVeraHome()): string {
    const root = join(veraRuntimeDirectoryIn(home), "scratch");
    let canonicalHome: string;
    try {
        canonicalHome = realpathSync(home);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
        throw error;
    }
    const runtime = veraRuntimeDirectoryIn(canonicalHome);
    const canonicalRoot = join(runtime, "scratch");
    assertDirectoryNotRedirected(runtime, "Vera runtime must stay inside its home");
    assertDirectoryNotRedirected(canonicalRoot, "Session scratch must stay inside its home");
    return root;
}

export function sessionScratchPath(sessionId: string, home = selectedVeraHome()): string {
    if (sessionId === "" || sessionId === "." || sessionId === ".." || basename(sessionId) !== sessionId) {
        throw new Error("Invalid session id for scratch directory");
    }
    return join(sessionScratchRoot(home), sessionId);
}

export function sessionScratchDir(
    sessionId: string,
    home = selectedVeraHome(),
    legacyRoot = join(tmpdir(), "vera"),
    move: typeof renameSync = renameSync,
): string {
    sessionScratchPath(sessionId, home);
    mkdirSync(home, { recursive: true });
    const runtime = veraRuntimeDirectoryIn(realpathSync(home));
    mkdirSync(runtime, { recursive: true });
    if (realpathSync(runtime) !== runtime) throw new Error("Vera runtime must stay inside its home");
    const root = join(runtime, "scratch");
    mkdirSync(root, { recursive: true });
    if (realpathSync(root) !== root) throw new Error("Session scratch must stay inside its home");
    const directory = join(root, sessionId);
    const legacy = join(legacyRoot, sessionId);
    if (entry(directory) === undefined && entry(legacy)?.isDirectory() === true) {
        try {
            move(legacy, directory);
        } catch {
            // The old directory stays in place when it cannot be renamed.
        }
    }
    const existing = entry(directory);
    if (existing !== undefined && !existing.isDirectory()) {
        throw new Error("Session scratch must be a directory");
    }
    mkdirSync(directory, { recursive: true });
    return realpathSync(directory);
}

function assertDirectoryNotRedirected(path: string, message: string): void {
    const existing = entry(path);
    if (existing === undefined) return;
    if (!existing.isDirectory() || realpathSync(path) !== path) throw new Error(message);
}

function entry(path: string): ReturnType<typeof lstatSync> | undefined {
    try {
        return lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}
