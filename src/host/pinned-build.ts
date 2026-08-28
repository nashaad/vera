import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
    cleanGitCheckoutCommit,
    cleanlyMatchesGitCommit,
    gitCheckoutRoot,
    materializeGitWorktree,
} from "../dev/git-checkout.ts";
import { veraMachineDirectory } from "../profile-paths.ts";

/**
 * Set on a client that was already re-executed from the pinned checkout, so
 * it runs in place instead of re-executing forever.
 */
export const PINNED_BUILD_ENV = "VERA_PINNED_BUILD";

/** Where the pinned checkout is materialized, relative to the repository. */
const PINNED_WORKTREE_PATH = join(".worktrees", "pinned");

export interface PinnedBuildRecord {
    /** The commit whose host was last seen to boot cleanly. */
    readonly commit: string;
    /** The checkout that commit was booted from. */
    readonly repository: string;
    readonly recorded_at: string;
}

/**
 * The pin belongs to the installation, not to a profile: a rescue running
 * under its own profile has to read the pin a `default` host recorded.
 */
function pinPath(): string {
    return join(veraMachineDirectory(), "pinned-build.json");
}

export function readPinnedBuild(): PinnedBuildRecord | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(pinPath(), "utf8"));
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
        typeof record.commit !== "string"
        || typeof record.repository !== "string"
        || typeof record.recorded_at !== "string"
    ) {
        return undefined;
    }
    return record as unknown as PinnedBuildRecord;
}

/**
 * Records the commit a host just booted from. Called only after the host is
 * serving, which is what makes the pin mean "this build boots" rather than
 * "this build is newest". Advancing it is the only way it ever moves.
 */
export function recordCleanBoot(
    entrypoint: string,
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (env[PINNED_BUILD_ENV] !== undefined) return;
    try {
        const repository = gitCheckoutRoot(entrypoint);
        if (repository === undefined) return;
        // A commit does not describe a tree with uncommitted edits in it, so
        // there is nothing here that could be checked out again later. An
        // older pin that does boot beats a new one that cannot be reproduced.
        const commit = cleanGitCheckoutCommit(repository);
        if (commit === undefined) return;
        const existing = readPinnedBuild();
        if (existing?.commit === commit && existing.repository === repository) {
            return;
        }
        const path = pinPath();
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const record: PinnedBuildRecord = {
            commit,
            repository,
            recorded_at: new Date().toISOString(),
        };
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(record, null, 4)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        renameSync(temporary, path);
    } catch {
        // The pin is a convenience for a later rescue. Failing to advance it
        // must never fail the boot that would have advanced it.
    }
}

/**
 * The CLI entrypoint of the pinned checkout, materializing that checkout if
 * it is missing or sitting on the wrong commit. Undefined whenever the pinned
 * build cannot be produced or would be the running build anyway, which leaves
 * the caller running in place.
 */
export function pinnedCliEntrypoint(
    entrypoint: string,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    if (env[PINNED_BUILD_ENV] !== undefined) return undefined;
    const pin = readPinnedBuild();
    if (pin === undefined) return undefined;
    const repository = gitCheckoutRoot(entrypoint);
    // A pin recorded from a different installation describes a tree this one
    // has no claim on, so it is ignored rather than reached into.
    if (repository === undefined || repository !== pin.repository) {
        return undefined;
    }
    // An unreadable HEAD is not proof the pin is unnecessary; carry on and
    // let worktree materialization decide whether the pin can be used.
    if (cleanlyMatchesGitCommit(repository, pin.commit) === true) {
        return undefined;
    }
    const worktree = materializeGitWorktree(
        repository,
        PINNED_WORKTREE_PATH,
        pin.commit,
    );
    if (worktree === undefined) return undefined;
    const cli = join(worktree, "clients", "cli", "main.ts");
    return existsSync(cli) ? cli : undefined;
}
