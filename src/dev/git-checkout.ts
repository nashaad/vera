import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const GIT_TIMEOUT_MS = 20_000;

function git(repository: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
    }).trim();
}

/** The Git checkout a file belongs to, or undefined when it belongs to none. */
export function gitCheckoutRoot(path: string): string | undefined {
    try {
        return git(dirname(path), ["rev-parse", "--show-toplevel"]);
    } catch {
        return undefined;
    }
}

/** The commit of a clean checkout, or undefined when it cannot be reproduced. */
export function cleanGitCheckoutCommit(repository: string): string | undefined {
    try {
        const status = git(repository, [
            "status",
            "--porcelain",
            "--untracked-files=no",
        ]);
        return status === "" ? git(repository, ["rev-parse", "HEAD"]) : undefined;
    } catch {
        return undefined;
    }
}

/** Whether a checkout cleanly matches a commit, when its state is readable. */
export function cleanlyMatchesGitCommit(
    repository: string,
    commit: string,
): boolean | undefined {
    try {
        return git(repository, ["rev-parse", "HEAD"]) === commit
            && git(repository, [
                "status",
                "--porcelain",
                "--untracked-files=no",
            ]) === "";
    } catch {
        return undefined;
    }
}

/** Materialize a detached worktree at a commit and return its path. */
export function materializeGitWorktree(
    repository: string,
    relativePath: string,
    commit: string,
): string | undefined {
    const worktree = join(repository, relativePath);
    try {
        if (existsSync(join(worktree, ".git"))) {
            if (git(worktree, ["rev-parse", "HEAD"]) !== commit) {
                git(worktree, ["checkout", "--detach", commit]);
            }
        } else {
            git(repository, [
                "worktree",
                "add",
                "--detach",
                worktree,
                commit,
            ]);
        }
        return worktree;
    } catch {
        return undefined;
    }
}
