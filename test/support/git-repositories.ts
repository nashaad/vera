import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

export function removeGitRepositories(): void {
    for (const path of temporaryDirectories.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
}

export function repository(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vera-git-repository-")));
    temporaryDirectories.push(root);
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(root, ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "src", "a.ts"), "a\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "initial"]);
    return repo;
}

export function addWorktree(repo: string, name: string): string {
    const path = join(repo, ".worktrees", name);
    git(repo, ["worktree", "add", "-q", "-b", name, path]);
    return path;
}

export function addSubmodule(repo: string, name: string): string {
    const source = join(repo, "..", `${name}-source`);
    mkdirSync(source);
    git(source, ["init", "-q", "-b", "main"]);
    writeFileSync(join(source, "a.txt"), "a\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-q", "-m", "initial"]);
    git(repo, ["submodule", "add", "-q", source, name]);
    return join(repo, name);
}

export function git(cwd: string, args: readonly string[]): void {
    const result = Bun.spawnSync({
        cmd: [
            "git",
            "-c", "user.name=Test",
            "-c", "user.email=test@example.com",
            "-c", "commit.gpgsign=false",
            "-c", "protocol.file.allow=always",
            ...args,
        ],
        cwd,
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
        );
    }
}
