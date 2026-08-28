import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    PINNED_BUILD_ENV,
    pinnedCliEntrypoint,
    readPinnedBuild,
    recordCleanBoot,
} from "../src/host/pinned-build.ts";
import { VERA_HOME_ENV } from "../src/profile-paths.ts";

const previousHome = process.env[VERA_HOME_ENV];
const roots: string[] = [];

afterEach(() => {
    if (previousHome === undefined) {
        delete process.env[VERA_HOME_ENV];
    } else {
        process.env[VERA_HOME_ENV] = previousHome;
    }
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function temporaryDirectory(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

function git(repository: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

/** A checkout shaped like Vera's: a CLI entrypoint at the path rescue runs. */
function repositoryWithCli(marker: string): string {
    const repository = temporaryDirectory("vera-pin-repo-");
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "test"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    mkdirSync(join(repository, "clients", "cli"), { recursive: true });
    writeFileSync(join(repository, "clients", "cli", "main.ts"), marker);
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-q", "-m", "first"]);
    return repository;
}

function useTemporaryHome(): string {
    const home = temporaryDirectory("vera-pin-home-");
    process.env[VERA_HOME_ENV] = home;
    return home;
}

function cliPath(repository: string): string {
    return join(repository, "clients", "cli", "main.ts");
}

test("a file outside any checkout has no repository to pin", () => {
    useTemporaryHome();
    const loose = temporaryDirectory("vera-pin-loose-");
    writeFileSync(join(loose, "main.ts"), "");
    recordCleanBoot(join(loose, "main.ts"), {});
    expect(readPinnedBuild()).toBeUndefined();
});

test("an installed entrypoint does not claim its containing repository", () => {
    const home = useTemporaryHome();
    const repository = temporaryDirectory("vera-pin-consumer-");
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "test"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repository, ".gitignore"), "node_modules/\n");
    git(repository, ["add", ".gitignore"]);
    git(repository, ["commit", "-q", "-m", "consumer"]);
    const entrypoint = join(
        repository,
        "node_modules",
        "@nashaad",
        "vera",
        "clients",
        "cli",
        "main.ts",
    );
    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, "installed build");

    recordCleanBoot(entrypoint, {});

    expect(readPinnedBuild()).toBeUndefined();
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(
        join(home, "machine", "pinned-build.json"),
        JSON.stringify({
            commit: git(repository, ["rev-parse", "HEAD"]),
            repository: git(repository, ["rev-parse", "--show-toplevel"]),
            recorded_at: new Date().toISOString(),
        }),
    );
    expect(pinnedCliEntrypoint(entrypoint, {})).toBeUndefined();
    expect(existsSync(join(repository, ".worktrees", "pinned"))).toBe(false);
});

test("a clean boot pins the commit it booted from", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), {});

    const pin = readPinnedBuild();
    expect(pin?.commit).toBe(git(repository, ["rev-parse", "HEAD"]));
    expect(pin?.repository).toBe(git(repository, ["rev-parse", "--show-toplevel"]));
});

test("a build that was itself launched from the pin does not re-pin", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), { [PINNED_BUILD_ENV]: "1" });
    expect(readPinnedBuild()).toBeUndefined();
});

test("a malformed pin reads as no pin", () => {
    const home = useTemporaryHome();
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(join(home, "machine", "pinned-build.json"), "not json");
    expect(readPinnedBuild()).toBeUndefined();
});

test("rescue runs in place when the pin is the running build", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), {});
    expect(pinnedCliEntrypoint(cliPath(repository), {})).toBeUndefined();
});

test("rescue runs the pinned commit after the checkout moved on", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), {});
    const pinned = git(repository, ["rev-parse", "HEAD"]);
    // The build the user is sitting on is broken; the pinned one is not.
    writeFileSync(cliPath(repository), "broken build");
    git(repository, ["commit", "-qam", "break the host"]);

    const entrypoint = pinnedCliEntrypoint(cliPath(repository), {});
    expect(entrypoint).toBeDefined();
    expect(existsSync(entrypoint as string)).toBe(true);
    const worktree = join(
        readPinnedBuild()?.repository as string,
        ".worktrees",
        "pinned",
    );
    expect(entrypoint).toBe(join(worktree, "clients", "cli", "main.ts"));
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(pinned);
});

test("a stale pinned worktree is moved to the recorded commit", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), {});
    writeFileSync(cliPath(repository), "second build");
    git(repository, ["commit", "-qam", "second"]);
    pinnedCliEntrypoint(cliPath(repository), {});

    // A later clean boot advances the pin; the worktree must follow it.
    recordCleanBoot(cliPath(repository), {});
    const advanced = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(cliPath(repository), "broken build");
    git(repository, ["commit", "-qam", "break the host"]);

    expect(pinnedCliEntrypoint(cliPath(repository), {})).toBeDefined();
    const worktree = join(
        readPinnedBuild()?.repository as string,
        ".worktrees",
        "pinned",
    );
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(advanced);
});

test("a dirty checkout does not advance the pin", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), {});
    const pinned = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(cliPath(repository), "second build");
    git(repository, ["commit", "-qam", "second"]);
    writeFileSync(cliPath(repository), "uncommitted edits");

    recordCleanBoot(cliPath(repository), {});
    expect(readPinnedBuild()?.commit).toBe(pinned);
});

test("uncommitted edits at the pinned commit still run the pinned build", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), {});
    // The commit is the pinned one, but the tree no longer matches it, and
    // the edits are the likeliest thing to have broken the host.
    writeFileSync(cliPath(repository), "broken build");

    const entrypoint = pinnedCliEntrypoint(cliPath(repository), {});
    expect(entrypoint).toBeDefined();
    expect(Bun.file(entrypoint as string).size).toBeGreaterThan(0);
});

test("a pin recorded by another installation is ignored", () => {
    useTemporaryHome();
    const pinnedRepository = repositoryWithCli("other install");
    recordCleanBoot(cliPath(pinnedRepository), {});
    const other = repositoryWithCli("this install");

    expect(pinnedCliEntrypoint(cliPath(other), {})).toBeUndefined();
});

test("a build launched from the pin does not relaunch itself", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordCleanBoot(cliPath(repository), {});
    writeFileSync(cliPath(repository), "broken build");
    git(repository, ["commit", "-qam", "break the host"]);

    expect(
        pinnedCliEntrypoint(cliPath(repository), { [PINNED_BUILD_ENV]: "1" }),
    ).toBeUndefined();
});
