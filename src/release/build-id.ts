import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CWD = fileURLToPath(new URL("../..", import.meta.url));
const DIRTY_DIGEST_LENGTH = 12;

export interface ReleaseSourceIdentity {
    readonly sourceRevision: string;
    readonly shortRevision: string;
    readonly dirty: boolean;
    readonly buildId: string;
}

function git(
    cwd: string,
    args: readonly string[],
): ReturnType<typeof Bun.spawnSync> {
    return Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
}

function gitOutput(cwd: string, args: readonly string[], error: string): Buffer {
    const result = git(cwd, args);
    if (result.exitCode !== 0) {
        const detail = result.stderr.toString().trim();
        throw new Error(detail.length > 0 ? `${error}: ${detail}` : error);
    }
    return Buffer.from(result.stdout);
}

function gitText(cwd: string, args: readonly string[], error: string): string {
    return gitOutput(cwd, args, error).toString();
}

function dirtyTreeDigest(cwd: string, status: string): string {
    const hash = createHash("sha256");
    hash.update(status);
    hash.update("\0");
    hash.update(gitOutput(
        cwd,
        ["diff", "HEAD"],
        "Release build id needs git diff",
    ));
    hash.update("\0");
    const untracked = gitText(
        cwd,
        ["ls-files", "-o", "--exclude-standard", "-z"],
        "Release build id needs git ls-files",
    );
    const paths = untracked.split("\0").filter((path) => path.length > 0);
    paths.sort();
    for (const relative of paths) {
        hash.update(relative);
        hash.update("\0");
        hash.update(readFileSync(join(cwd, relative)));
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, DIRTY_DIGEST_LENGTH);
}

/**
 * Exact build identity for this tree. A clean commit is `vera-<shortsha>`.
 * A dirty tree adds a content digest so two dirty states of the same commit
 * cannot share an id. The digest is the working tree, not a boolean `+dirty`.
 */
export function releaseSourceIdentity(
    cwd: string = DEFAULT_CWD,
): ReleaseSourceIdentity {
    const sourceRevision = gitText(
        cwd,
        ["rev-parse", "HEAD"],
        "Release build id needs git rev-parse",
    ).trim();
    if (sourceRevision.length === 0) {
        throw new Error("Release build id got an empty git revision");
    }
    const shortRevision = gitText(
        cwd,
        ["rev-parse", "--short", "HEAD"],
        "Release build id needs git rev-parse --short",
    ).trim();
    if (shortRevision.length === 0) {
        throw new Error("Release build id got an empty short git revision");
    }
    const status = gitText(
        cwd,
        ["status", "--porcelain", "--untracked-files=normal"],
        "Release build id needs git status",
    );
    const dirty = status.trim().length > 0;
    if (!dirty) {
        return {
            sourceRevision,
            shortRevision,
            dirty: false,
            buildId: `vera-${shortRevision}`,
        };
    }
    return {
        sourceRevision,
        shortRevision,
        dirty: true,
        buildId: `vera-${shortRevision}+${dirtyTreeDigest(cwd, status)}`,
    };
}

export function releaseBuildId(cwd: string = DEFAULT_CWD): string {
    return releaseSourceIdentity(cwd).buildId;
}

export function tryReleaseBuildId(cwd: string = DEFAULT_CWD): string | undefined {
    try {
        return releaseBuildId(cwd);
    } catch {
        return undefined;
    }
}
