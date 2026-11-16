import { afterEach, expect, test } from "bun:test";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function run(
    command: string,
    args: readonly string[],
    cwd: string,
    options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        input: options.input,
        env: options.env ?? process.env,
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.error ?? result.stderr}`);
    }
    return result.stdout;
}

test("the release overlay contains the live worktree, including staged changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-smoke-overlay-"));
    directories.push(directory);
    const repo = join(directory, "repo");
    const bin = join(directory, "bin");
    const capture = join(directory, "capture");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(capture);
    copyFileSync(
        join(import.meta.dir, "../../scripts/linux-release-smoke.sh"),
        join(repo, "scripts/linux-release-smoke.sh"),
    );
    for (const path of ["staged-edit", "staged-delete", "unstaged-delete", "restored", "old-name", "line\nbreak"]) {
        writeFileSync(join(repo, path), "base\n");
    }
    writeFileSync(join(repo, ".gitignore"), "ignored\n");
    run("git", ["init", "-q"], repo);
    run("git", ["add", "--all"], repo);
    const tree = run("git", ["write-tree"], repo).trim();
    const commit = run("git", [
        "-c", "user.name=nashaad", "-c", "user.email=nashaad@gmail.com", "commit-tree", tree,
    ], repo, { input: "scratch baseline\n" }).trim();
    run("git", ["update-ref", "refs/heads/main", commit], repo);
    run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], repo);

    writeFileSync(join(repo, "staged-edit"), "staged\n");
    writeFileSync(join(repo, "staged-new"), "new\n");
    run("git", ["add", "staged-edit", "staged-new"], repo);
    writeFileSync(join(repo, "staged-edit"), "latest\n");
    run("git", ["rm", "-q", "--", "staged-delete", "restored"], repo);
    writeFileSync(join(repo, "restored"), "restored\n");
    unlinkSync(join(repo, "unstaged-delete"));
    unlinkSync(join(repo, "line\nbreak"));
    run("git", ["mv", "old-name", "new-name"], repo);
    writeFileSync(join(repo, "untracked"), "untracked\n");
    writeFileSync(join(repo, "new\nline"), "newline\n");
    writeFileSync(join(repo, "ignored"), "ignored\n");

    const docker = join(bin, "docker");
    writeFileSync(docker, `#!/bin/sh
set -eu
if [ "$1" = info ]; then exit 0; fi
shift
while [ "$#" -gt 0 ]; do
    if [ "$1" = -v ]; then
        case "$2" in
            *:/smoke)
                work=\${2%:/smoke}
                cp "$work/source.bundle" "$SMOKE_CAPTURE/source.bundle"
                cp "$work/changes.tar" "$SMOKE_CAPTURE/changes.tar"
                cp "$work/deleted.list" "$SMOKE_CAPTURE/deleted.list"
                : > "$work/out/vera-linux-x64.tar.gz"
                ;;
        esac
        shift
    fi
    shift
done
`);
    chmodSync(docker, 0o755);
    run("sh", ["scripts/linux-release-smoke.sh", "x64"], repo, {
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            SMOKE_CAPTURE: capture,
            TMPDIR: directory,
            VERA_SMOKE_KEEP: "",
        },
    });

    const clone = join(directory, "clone");
    run("git", ["clone", "-q", join(capture, "source.bundle"), clone], directory);
    const deletions = readFileSync(join(capture, "deleted.list"), "utf8").split("\0").filter(Boolean);
    for (const path of deletions) unlinkSync(join(clone, path));
    run("tar", ["-xf", join(capture, "changes.tar"), "-C", clone], directory);

    for (const [path, content] of [
        ["staged-edit", "latest\n"],
        ["staged-new", "new\n"],
        ["restored", "restored\n"],
        ["new-name", "base\n"],
        ["untracked", "untracked\n"],
        ["new\nline", "newline\n"],
    ] as const) {
        expect(readFileSync(join(clone, path), "utf8")).toBe(content);
    }
    for (const path of ["staged-delete", "unstaged-delete", "old-name", "line\nbreak", "ignored"]) {
        expect(existsSync(join(clone, path))).toBe(false);
    }
});
