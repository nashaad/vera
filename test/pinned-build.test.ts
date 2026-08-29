import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    capturePinnedBuild,
    PINNED_BUILD_ENV,
    pinnedCliEntrypoint,
    type PinnedBuildRecord,
    readPinnedBuild,
    recordCleanBoot,
} from "../src/host/pinned-build.ts";
import { VERA_HOME_ENV } from "../src/profile-paths.ts";

const previousHome = process.env[VERA_HOME_ENV];
const previousInstallCache = process.env.BUN_INSTALL_CACHE_DIR;
const previousTmpdir = process.env.TMPDIR;
const roots: string[] = [];

afterEach(() => {
    if (previousHome === undefined) {
        delete process.env[VERA_HOME_ENV];
    } else {
        process.env[VERA_HOME_ENV] = previousHome;
    }
    if (previousInstallCache === undefined) {
        delete process.env.BUN_INSTALL_CACHE_DIR;
    } else {
        process.env.BUN_INSTALL_CACHE_DIR = previousInstallCache;
    }
    if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
    } else {
        process.env.TMPDIR = previousTmpdir;
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

function writeLockfile(repository: string): void {
    execFileSync(process.execPath, ["install", "--lockfile-only", "--ignore-scripts"], {
        cwd: repository,
        stdio: ["ignore", "ignore", "ignore"],
    });
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
    writeFileSync(
        join(repository, "package.json"),
        `${JSON.stringify({ name: "fixture", private: true }, null, 4)}\n`,
    );
    writeLockfile(repository);
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

function recordBoot(
    entrypoint: string,
    env: NodeJS.ProcessEnv = {},
): void {
    recordCleanBoot(capturePinnedBuild(entrypoint, env));
}

function worktreeForCli(entrypoint: string): string {
    return dirname(dirname(dirname(entrypoint)));
}

function onlyInstallationDirectory(home: string): string {
    const root = join(home, "machine", "pinned-builds");
    const entries = readdirSync(root);
    expect(entries).toHaveLength(1);
    return join(root, entries[0] as string);
}

test("a file outside any checkout has no repository to pin", () => {
    useTemporaryHome();
    const loose = temporaryDirectory("vera-pin-loose-");
    writeFileSync(join(loose, "main.ts"), "");
    recordBoot(join(loose, "main.ts"));
    expect(readPinnedBuild(join(loose, "main.ts"))).toBeUndefined();
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

    recordBoot(entrypoint);

    expect(readPinnedBuild(entrypoint)).toBeUndefined();
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
    recordBoot(cliPath(repository));

    const pin = readPinnedBuild(cliPath(repository));
    expect(pin?.commit).toBe(git(repository, ["rev-parse", "HEAD"]));
    expect(pin?.repository).toBe(git(repository, ["rev-parse", "--show-toplevel"]));
});

test("the recorded commit is the one captured before startup", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    const captured = capturePinnedBuild(cliPath(repository), {});
    const booted = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(cliPath(repository), "second build");
    git(repository, ["commit", "-qam", "checkout moved during startup"]);

    recordCleanBoot(captured);

    expect(readPinnedBuild(cliPath(repository))?.commit).toBe(booted);
});

test("a build that was itself launched from the pin does not re-pin", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository), { [PINNED_BUILD_ENV]: "1" });
    expect(readPinnedBuild(cliPath(repository))).toBeUndefined();
});

test("a malformed pin reads as no pin", () => {
    const home = useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    writeFileSync(
        join(onlyInstallationDirectory(home), "record.json"),
        "not json",
    );
    expect(readPinnedBuild(cliPath(repository))).toBeUndefined();
});

test("a clean boot migrates a matching legacy pin", () => {
    const home = useTemporaryHome();
    const repository = repositoryWithCli("first build");
    const legacy: PinnedBuildRecord = {
        commit: git(repository, ["rev-parse", "HEAD"]),
        repository: git(repository, ["rev-parse", "--show-toplevel"]),
        recorded_at: new Date().toISOString(),
    };
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(
        join(home, "machine", "pinned-build.json"),
        `${JSON.stringify(legacy)}\n`,
    );

    recordBoot(cliPath(repository));

    expect(existsSync(join(
        onlyInstallationDirectory(home),
        "record.json",
    ))).toBe(true);
});

test("rescue runs in place when the pin is the running build", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    expect(pinnedCliEntrypoint(cliPath(repository), {})).toBeUndefined();
});

test("rescue runs the pinned commit from Vera's private state", () => {
    const home = useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    const pinned = git(repository, ["rev-parse", "HEAD"]);
    // The build the user is sitting on is broken; the pinned one is not.
    writeFileSync(cliPath(repository), "broken build");
    git(repository, ["commit", "-qam", "break the host"]);

    const entrypoint = pinnedCliEntrypoint(cliPath(repository), {});
    expect(entrypoint).toBeDefined();
    expect(existsSync(entrypoint as string)).toBe(true);
    const worktree = worktreeForCli(entrypoint as string);
    expect(worktree.startsWith(join(home, "machine", "pinned-builds"))).toBe(true);
    expect(worktree.startsWith(join(repository, ".worktrees"))).toBe(false);
    expect(entrypoint).toBe(join(worktree, "clients", "cli", "main.ts"));
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(pinned);
});

test("a stale pinned worktree is moved to the recorded commit", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    writeFileSync(cliPath(repository), "second build");
    git(repository, ["commit", "-qam", "second"]);
    pinnedCliEntrypoint(cliPath(repository), {});

    // A later clean boot advances the pin; the worktree must follow it.
    recordBoot(cliPath(repository));
    const advanced = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(cliPath(repository), "broken build");
    git(repository, ["commit", "-qam", "break the host"]);

    const entrypoint = pinnedCliEntrypoint(cliPath(repository), {});
    expect(entrypoint).toBeDefined();
    const worktree = worktreeForCli(entrypoint as string);
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(advanced);
});

test("rescue refuses a foreign repository at its private checkout path", () => {
    const home = useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    writeFileSync(cliPath(repository), "broken build");
    git(repository, ["commit", "-qam", "break the host"]);
    const worktree = join(onlyInstallationDirectory(home), "checkout");
    mkdirSync(worktree);
    git(worktree, ["init", "-q", "-b", "main"]);
    git(worktree, ["config", "user.email", "test@example.com"]);
    git(worktree, ["config", "user.name", "test"]);
    git(worktree, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(worktree, "foreign.txt"), "do not move");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-q", "-m", "foreign"]);
    const foreignHead = git(worktree, ["rev-parse", "HEAD"]);

    expect(pinnedCliEntrypoint(cliPath(repository), {})).toBeUndefined();
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(foreignHead);
    expect(git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
});

test("a dirty checkout does not advance the pin", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    const pinned = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(cliPath(repository), "second build");
    git(repository, ["commit", "-qam", "second"]);
    writeFileSync(cliPath(repository), "uncommitted edits");

    recordBoot(cliPath(repository));
    expect(readPinnedBuild(cliPath(repository))?.commit).toBe(pinned);
});

test("uncommitted edits at the pinned commit still run the pinned build", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    // The commit is the pinned one, but the tree no longer matches it, and
    // the edits are the likeliest thing to have broken the host.
    writeFileSync(cliPath(repository), "broken build");

    const entrypoint = pinnedCliEntrypoint(cliPath(repository), {});
    expect(entrypoint).toBeDefined();
    expect(Bun.file(entrypoint as string).size).toBeGreaterThan(0);
});

test("rescue installs dependencies from the pinned lockfile", () => {
    useTemporaryHome();
    const installScratch = realpathSync(temporaryDirectory("vera-pin-install-"));
    process.env.TMPDIR = installScratch;
    process.env.BUN_INSTALL_CACHE_DIR = join(installScratch, "cache");
    const repository = repositoryWithCli("first build");
    const dependency = join(repository, "vendor", "fixture-runtime");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
        join(dependency, "package.json"),
        `${JSON.stringify({ name: "fixture-runtime", version: "1.0.0" })}\n`,
    );
    writeFileSync(join(dependency, "index.js"), "known good dependency\n");
    writeFileSync(
        join(repository, "package.json"),
        `${JSON.stringify({
            name: "fixture",
            private: true,
            dependencies: { "fixture-runtime": "file:vendor/fixture-runtime" },
        }, null, 4)}\n`,
    );
    writeLockfile(repository);
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-q", "-m", "add dependency"]);
    recordBoot(cliPath(repository));

    rmSync(join(repository, "vendor"), { recursive: true, force: true });
    writeFileSync(
        join(repository, "package.json"),
        `${JSON.stringify({ name: "fixture", private: true }, null, 4)}\n`,
    );
    writeLockfile(repository);
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-q", "-m", "break dependency state"]);

    const entrypoint = pinnedCliEntrypoint(cliPath(repository), {});
    expect(entrypoint).toBeDefined();
    expect(readFileSync(join(
        worktreeForCli(entrypoint as string),
        "node_modules",
        "fixture-runtime",
        "index.js",
    ), "utf8")).toBe("known good dependency\n");
});

test("different installations retain independent pins", () => {
    const home = useTemporaryHome();
    const first = repositoryWithCli("first install");
    const second = repositoryWithCli("second install");
    recordBoot(cliPath(first));
    const firstCommit = git(first, ["rev-parse", "HEAD"]);
    recordBoot(cliPath(second));
    const secondCommit = git(second, ["rev-parse", "HEAD"]);

    expect(readPinnedBuild(cliPath(first))?.commit).toBe(firstCommit);
    expect(readPinnedBuild(cliPath(second))?.commit).toBe(secondCommit);
    expect(
        readdirSync(join(home, "machine", "pinned-builds")),
    ).toHaveLength(2);
});

test("a build launched from the pin does not relaunch itself", () => {
    useTemporaryHome();
    const repository = repositoryWithCli("first build");
    recordBoot(cliPath(repository));
    writeFileSync(cliPath(repository), "broken build");
    git(repository, ["commit", "-qam", "break the host"]);

    expect(
        pinnedCliEntrypoint(cliPath(repository), { [PINNED_BUILD_ENV]: "1" }),
    ).toBeUndefined();
});
