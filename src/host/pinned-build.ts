import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { veraMachineDirectory } from "../profile-paths.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

/** Set after re-executing from the pinned checkout to prevent recursion. */
export const PINNED_BUILD_ENV = "VERA_PINNED_BUILD";

const GIT_TIMEOUT_MS = 20_000;
const DEPENDENCY_INSTALL_TIMEOUT_MS = 60_000;

export interface PinnedBuildCandidate {
    /** The commit present immediately before host startup began. */
    readonly commit: string;
    /** The checkout that supplied the host. */
    readonly repository: string;
}

export interface PinnedBuildRecord extends PinnedBuildCandidate {
    readonly recorded_at: string;
}

function git(repository: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
    }).trim();
}

/**
 * The repository that tracks a file, or undefined when it belongs to none.
 * Checking that the entrypoint is tracked prevents an installed package from
 * claiming a consuming project's repository merely because it sits below it.
 */
function checkoutRoot(path: string): string | undefined {
    try {
        const canonicalPath = realpathSync(path);
        const repository = git(dirname(canonicalPath), [
            "rev-parse",
            "--show-toplevel",
        ]);
        const entry = relative(repository, canonicalPath);
        if (
            entry === ""
            || entry === ".."
            || isAbsolute(entry)
            || entry.startsWith(`..${sep}`)
        ) {
            return undefined;
        }
        git(repository, ["ls-files", "--error-unmatch", "--", entry]);
        return repository;
    } catch {
        return undefined;
    }
}

/** Whether a checkout's tracked files match its commit. */
function isClean(repository: string): boolean {
    return git(repository, ["status", "--porcelain", "--untracked-files=no"])
        === "";
}

function installationKey(repository: string): string {
    return createHash("sha256").update(repository).digest("hex");
}

function installationDirectory(repository: string): string {
    return join(
        veraMachineDirectory(),
        "pinned-builds",
        installationKey(repository),
    );
}

function pinPath(repository: string): string {
    return join(installationDirectory(repository), "record.json");
}

function pinnedWorktreePath(repository: string): string {
    return join(installationDirectory(repository), "checkout");
}

function parsePinnedBuild(path: string): PinnedBuildRecord | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readRegularFileTextSync(path));
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

function readPinnedBuildFor(repository: string): PinnedBuildRecord | undefined {
    const current = parsePinnedBuild(pinPath(repository));
    if (current?.repository === repository) return current;

    // Preserve a usable pin from the former machine-global layout. A later
    // clean boot writes it into the installation-scoped location.
    const legacy = parsePinnedBuild(join(veraMachineDirectory(), "pinned-build.json"));
    return legacy?.repository === repository ? legacy : undefined;
}

export function readPinnedBuild(entrypoint: string): PinnedBuildRecord | undefined {
    const repository = checkoutRoot(entrypoint);
    return repository === undefined ? undefined : readPinnedBuildFor(repository);
}

/** Capture the reproducible checkout state before host startup begins. */
export function capturePinnedBuild(
    entrypoint: string,
    env: NodeJS.ProcessEnv = process.env,
): PinnedBuildCandidate | undefined {
    if (env[PINNED_BUILD_ENV] !== undefined) return undefined;
    try {
        const repository = checkoutRoot(entrypoint);
        if (repository === undefined) return undefined;
        const commit = git(repository, ["rev-parse", "HEAD"]);
        if (!isClean(repository)) return undefined;
        // Refuse a capture that raced with a checkout change.
        if (git(repository, ["rev-parse", "HEAD"]) !== commit) return undefined;
        return { commit, repository };
    } catch {
        return undefined;
    }
}

/** Persist a captured build only after its host has begun serving. */
export function recordCleanBoot(candidate: PinnedBuildCandidate | undefined): void {
    if (candidate === undefined) return;
    try {
        const existing = parsePinnedBuild(pinPath(candidate.repository));
        if (
            existing?.commit === candidate.commit
            && existing.repository === candidate.repository
        ) {
            return;
        }
        const path = pinPath(candidate.repository);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const record: PinnedBuildRecord = {
            ...candidate,
            recorded_at: new Date().toISOString(),
        };
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(record, null, 4)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        renameSync(temporary, path);
    } catch {
        // A pin is a convenience for later rescue. Recording failure must not
        // fail the healthy boot that would have advanced it.
    }
}

function gitCommonDirectory(repository: string): string {
    return realpathSync(git(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ]));
}

function isOwnedWorktree(repository: string, worktree: string): boolean {
    try {
        return realpathSync(worktree) === git(worktree, [
            "rev-parse",
            "--show-toplevel",
        ])
            && gitCommonDirectory(worktree) === gitCommonDirectory(repository);
    } catch {
        return false;
    }
}

function installPinnedDependencies(worktree: string): boolean {
    const packagePath = join(worktree, "package.json");
    if (!existsSync(packagePath)) return false;
    if (!existsSync(join(worktree, "bun.lock"))) {
        try {
            const manifest = JSON.parse(
                readRegularFileTextSync(packagePath),
            ) as {
                readonly dependencies?: Record<string, unknown>;
                readonly optionalDependencies?: Record<string, unknown>;
            };
            return Object.keys(manifest.dependencies ?? {}).length === 0
                && Object.keys(manifest.optionalDependencies ?? {}).length === 0;
        } catch {
            return false;
        }
    }
    try {
        execFileSync(process.execPath, [
            "install",
            "--frozen-lockfile",
            "--production",
            "--ignore-scripts",
            "--prefer-offline",
            "--no-progress",
            "--no-summary",
        ], {
            cwd: worktree,
            stdio: ["ignore", "ignore", "ignore"],
            timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Materialize the last build captured before a successful host start. Returns
 * undefined when no installation-scoped pin can be reproduced safely.
 */
export function pinnedCliEntrypoint(
    entrypoint: string,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    if (env[PINNED_BUILD_ENV] !== undefined) return undefined;
    const repository = checkoutRoot(entrypoint);
    if (repository === undefined) return undefined;
    const pin = readPinnedBuildFor(repository);
    if (pin === undefined) return undefined;
    try {
        if (
            git(repository, ["rev-parse", "HEAD"]) === pin.commit
            && isClean(repository)
        ) {
            return undefined;
        }
    } catch {
        // Let worktree materialization decide whether the pin remains usable.
    }

    const worktree = pinnedWorktreePath(repository);
    try {
        if (existsSync(join(worktree, ".git"))) {
            if (!isOwnedWorktree(repository, worktree)) return undefined;
            if (git(worktree, ["rev-parse", "HEAD"]) !== pin.commit) {
                git(worktree, ["checkout", "--detach", pin.commit]);
            }
        } else {
            mkdirSync(dirname(worktree), { recursive: true, mode: 0o700 });
            git(repository, [
                "worktree",
                "add",
                "--detach",
                worktree,
                pin.commit,
            ]);
        }
    } catch {
        return undefined;
    }
    const cli = join(worktree, "clients", "cli", "main.ts");
    if (!existsSync(cli) || !installPinnedDependencies(worktree)) return undefined;
    return cli;
}
