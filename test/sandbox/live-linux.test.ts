import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostLogEntry } from "../../src/host/host-log.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";
import { ManagedProcessRegistry } from "../../src/tools/process-runtime.ts";

// Real srt and real bubblewrap. Run scripts/linux-sandbox-live.sh, which
// supplies bubblewrap, socat and the user the cases assume.
const linux = process.platform === "linux";
const directories: string[] = [];
const startedIn = process.cwd();
let callerDirectory: string | undefined;

beforeAll(() => {
    if (!linux) return;
    callerDirectory = mkdtempSync(join(tmpdir(), "vera-sandbox-caller-"));
    process.chdir(callerDirectory);
});

afterAll(() => {
    if (callerDirectory !== undefined) {
        process.chdir(startedIn);
        rmSync(callerDirectory, { recursive: true, force: true });
    }
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function directory(prefix = "vera-sandbox-linux-"): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    directories.push(path);
    return path;
}

function shellPath(path: string): string {
    return `'${path.replaceAll("'", "'\\''")}'`;
}

function registryWithLog(): {
    readonly registry: ManagedProcessRegistry;
    readonly entries: HostLogEntry[];
} {
    const entries: HostLogEntry[] = [];
    const sandbox = new SandboxManager({
        config: () => ({ enabled: true, network: "open", allowed_domains: [] }),
        permissionRules: () => [],
        log: (entry) => entries.push(entry),
    });
    return { registry: new ManagedProcessRegistry({ sandbox }), entries };
}

async function run(
    registry: ManagedProcessRegistry,
    workspace: string,
    command: string,
    toolCallId: string,
) {
    return registry.scope("live-linux").run({
        command,
        cwd: workspace,
        env: { ...process.env },
        interactive: false,
        sandbox: { sessionId: "live-linux", toolCallId },
    });
}

function exited(
    result: Awaited<ReturnType<typeof run>>,
): { readonly exitCode: number | null; readonly output: string } {
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") throw new Error("command did not run");
    return {
        exitCode: result.snapshot.exitCode ?? null,
        output: result.snapshot.output,
    };
}

test("@core Linux blocks srt's protected names at the workspace root", async () => {
    if (!linux) return;
    const workspace = directory();
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    writeFileSync(join(workspace, ".git", "config"), "[core]\n");
    mkdirSync(join(workspace, ".vscode"), { recursive: true });
    const { registry } = registryWithLog();
    const before = readdirSync(workspace).sort();

    const hook = exited(await run(registry, workspace,
        "echo x > .git/hooks/pre-commit", "hook"));
    expect(hook.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readdirSync(workspace).sort()).toEqual(before);

    const config = exited(await run(registry, workspace,
        "echo '[x]' >> .git/config", "config"));
    expect(config.exitCode).not.toBe(0);
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(readdirSync(workspace).sort()).toEqual(before);

    const startup = exited(await run(registry, workspace,
        "echo x > .bashrc", "startup"));
    expect(startup.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".bashrc"))).toBe(false);
    expect(readdirSync(workspace).sort()).toEqual(before);

    const editor = exited(await run(registry, workspace,
        "echo x > .vscode/settings.json", "editor"));
    expect(editor.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".vscode", "settings.json"))).toBe(false);
    // No mount-point placeholder survived any of the four commands.
    expect(readdirSync(workspace).sort()).toEqual(before);
});

test("@core Linux blocks a nested repository's protected names", async () => {
    if (!linux) return;
    const workspace = directory();
    mkdirSync(join(workspace, "sub", ".git"), { recursive: true });
    mkdirSync(join(workspace, "sub", ".vscode"), { recursive: true });
    writeFileSync(join(workspace, "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(workspace, "sub", ".git", "config"), "[core]\n");
    const { registry } = registryWithLog();

    const hooks = exited(await run(registry, workspace,
        "echo x > sub/.git/hooks/pre-commit", "nested-hooks"));
    expect(hooks.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, "sub", ".git", "hooks"))).toBe(false);

    const config = exited(await run(registry, workspace,
        "echo '[x]' >> sub/.git/config", "nested-config"));
    expect(config.exitCode).not.toBe(0);
    expect(readFileSync(join(workspace, "sub", ".git", "config"), "utf8"))
        .toBe("[core]\n");

    const editor = exited(await run(registry, workspace,
        "echo x > sub/.vscode/settings.json", "nested-editor"));
    expect(editor.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, "sub", ".vscode", "settings.json"))).toBe(false);
});

test("@core Linux protects the project's Vera config and rules", async () => {
    if (!linux) return;
    const workspace = directory();
    const { registry } = registryWithLog();
    const before = readdirSync(workspace).sort();

    const created = exited(await run(registry, workspace,
        "echo x > .vera/config.json", "project-config-absent"));
    expect(created.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".vera", "config.json"))).toBe(false);

    const rules = exited(await run(registry, workspace,
        "mkdir -p .vera/rules && echo x > .vera/rules/x.md", "project-rules-absent"));
    expect(rules.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".vera", "rules", "x.md"))).toBe(false);

    // The mount points srt creates for absent denies are gone afterwards.
    expect(readdirSync(workspace).sort()).toEqual(before);

    mkdirSync(join(workspace, ".vera", "rules"), { recursive: true });
    writeFileSync(join(workspace, ".vera", "config.json"), '{"original":true}\n');
    writeFileSync(join(workspace, ".vera", "rules", "keep.md"), "keep\n");

    const overwritten = exited(await run(registry, workspace,
        "echo x > .vera/config.json", "project-config-present"));
    expect(overwritten.exitCode).not.toBe(0);
    expect(readFileSync(join(workspace, ".vera", "config.json"), "utf8"))
        .toBe('{"original":true}\n');

    const rule = exited(await run(registry, workspace,
        "echo x > .vera/rules/keep.md", "project-rule-present"));
    expect(rule.exitCode).not.toBe(0);
    expect(readFileSync(join(workspace, ".vera", "rules", "keep.md"), "utf8"))
        .toBe("keep\n");

    const bypass = exited(await run(registry, workspace,
        "mv .vera .vera-old && mkdir -p .vera/rules && echo x > .vera/rules/x.md",
        "project-rename"));
    expect(bypass.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".vera-old"))).toBe(false);
    expect(readFileSync(join(workspace, ".vera", "config.json"), "utf8"))
        .toBe('{"original":true}\n');

    const skills = exited(await run(registry, workspace,
        "mkdir -p .vera/skills && echo ok > .vera/skills/good.md", "project-skills"));
    expect(skills.exitCode).toBe(0);
    expect(readFileSync(join(workspace, ".vera", "skills", "good.md"), "utf8"))
        .toBe("ok\n");
});

test("@core Linux can commit in a linked worktree while shared hooks stay blocked", async () => {
    if (!linux) return;
    const root = directory();
    const git = (...args: string[]): void => {
        execFileSync("git", args, {
            cwd: root,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "crow",
                GIT_AUTHOR_EMAIL: "crow@example.test",
                GIT_COMMITTER_NAME: "crow",
                GIT_COMMITTER_EMAIL: "crow@example.test",
            },
        });
    };
    git("init", "-q");
    git("config", "user.name", "crow");
    git("config", "user.email", "crow@example.test");
    writeFileSync(join(root, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-q", "-m", "base");
    git("worktree", "add", "-q", join(root, "wt"), "-b", "wt");
    writeFileSync(join(root, "wt", "f.txt"), "f\n");

    const { registry } = registryWithLog();
    const worktree = join(root, "wt");
    const added = exited(await run(registry, worktree, "git add f.txt", "git-add"));
    expect(added.exitCode).toBe(0);
    const committed = exited(await run(registry, worktree,
        `git commit -q -m work`, "git-commit"));
    expect(committed.exitCode).toBe(0);
    expect(execFileSync("git", ["log", "--oneline", "-1"], { cwd: worktree }).toString())
        .toContain("work");

    const sharedHook = exited(await run(registry, worktree,
        `echo x > ${shellPath(join(root, ".git", "hooks", "pre-commit"))}`, "shared-hook"));
    expect(sharedHook.exitCode).not.toBe(0);
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
});

test("@core Linux refuses to create .git or .vera in a folder that has neither", async () => {
    if (!linux) return;
    const workspace = directory();
    const { registry } = registryWithLog();

    // srt mounts over an absent deny path, so the folder that would hold the
    // mount point cannot be created by the command either. Setting up a
    // repository or a project's Vera folder is done outside the sandbox.
    const init = exited(await run(registry, workspace, "git init -q", "empty-init"));
    expect(init.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".git"))).toBe(false);

    const vera = exited(await run(registry, workspace, "mkdir -p .vera/skills", "empty-vera"));
    expect(vera.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".vera"))).toBe(false);
    expect(readdirSync(workspace)).toEqual([]);
});

test("@core Linux denies a whole folder this user cannot read", async () => {
    // Root reads every mode, so there is nothing unreadable to test as root.
    if (!linux || process.getuid?.() === 0) return;
    const workspace = directory();
    const locked = join(workspace, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
        const { registry } = registryWithLog();
        const denied = exited(await run(registry, workspace,
            "echo x > locked/f", "unreadable-write"));
        expect(denied.exitCode).not.toBe(0);
        expect(existsSync(join(locked, "f"))).toBe(false);

        // The scan did not refuse the command: the sandbox ran it, and an
        // ordinary write still works.
        const control = exited(await run(registry, workspace,
            "touch ok.txt", "unreadable-control"));
        expect(control.exitCode).toBe(0);
        expect(existsSync(join(workspace, "ok.txt"))).toBe(true);
    } finally {
        chmodSync(locked, 0o755);
    }
});
