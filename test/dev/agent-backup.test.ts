import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
    new URL("../../dev/agent-guidance/sync-backups.ts", import.meta.url),
);
const HOOKS = fileURLToPath(new URL("../../dev/hooks", import.meta.url));

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-agent-backup-"));
    temporaryDirectories.push(directory);
    return directory;
}

function temporaryProject(): string {
    const root = temporaryDirectory();
    installScript(root);
    return root;
}

function installScript(root: string): void {
    const directory = join(root, "dev", "agent-guidance");
    mkdirSync(directory, { recursive: true });
    copyFileSync(SCRIPT, join(directory, "sync-backups.ts"));
}

function installHooks(root: string): void {
    cpSync(HOOKS, join(root, "dev", "hooks"), { recursive: true });
}

function write(root: string, path: string, contents: string): void {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
}

function read(root: string, path: string): string {
    return readFileSync(join(root, path), "utf8");
}

function isolatedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.VERA_AGENT_BACKUP_DIR;
    return { ...environment, ...extra };
}

function runScript(
    root: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
    return spawnSync(
        process.execPath,
        [join(root, "dev", "agent-guidance", "sync-backups.ts"), ...args],
        {
            cwd: root,
            encoding: "utf8",
            env: isolatedEnvironment(environment),
        },
    );
}

function runShell(
    command: string,
    args: readonly string[],
    root: string,
    environment: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
    return spawnSync("/bin/sh", [command, ...args], {
        cwd: root,
        encoding: "utf8",
        env: isolatedEnvironment(environment),
    });
}

function runGit(root: string, args: readonly string[]): string {
    const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: isolatedEnvironment(),
    });
    if (result.status !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr ?? ""}`,
        );
    }
    return result.stdout ?? "";
}

function commit(root: string, message: string): void {
    runGit(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        message,
    ]);
}

describe("sync", () => {
    test("copies the covered set, including nested files", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");
        write(root, "CLAUDE.md", "root guidance");
        write(root, ".agent-notes/index.md", "index");
        write(root, ".agent-notes/memory/note.md", "note");
        write(root, ".vera/rules/paths.md", "rule");
        write(root, ".claude/rules/paths.md", "mirror rule");
        write(root, ".claude/settings.json", "{\"settings\":true}");
        write(root, ".claude/settings.local.json", "{\"local\":true}");

        const backup = join(root, "backup");
        mkdirSync(backup);
        const result = runScript(root, [], { VERA_AGENT_BACKUP_DIR: backup });

        expect(result.status).toBe(0);
        expect(read(backup, "AGENTS.local.md")).toBe("agents");
        expect(read(backup, "CLAUDE.md")).toBe("root guidance");
        expect(read(backup, "agent-notes/index.md")).toBe("index");
        expect(read(backup, "agent-notes/memory/note.md")).toBe("note");
        expect(read(backup, ".vera/rules/paths.md")).toBe("rule");
        expect(read(backup, ".claude/rules/paths.md")).toBe("mirror rule");
        expect(read(backup, ".claude/settings.json")).toBe("{\"settings\":true}");
        expect(read(backup, ".claude/settings.local.json"))
            .toBe("{\"local\":true}");

        const check = runScript(root, ["--check"], {
            VERA_AGENT_BACKUP_DIR: backup,
        });
        expect(check.status).toBe(0);
        expect(check.stdout).toContain("current");
    });

    test("skips .DS_Store at every depth", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");
        write(root, ".agent-notes/index.md", "index");
        write(root, ".agent-notes/.DS_Store", "junk");
        write(root, ".agent-notes/memory/.DS_Store", "junk");
        write(root, ".claude/rules/.DS_Store", "junk");

        const backup = join(root, "backup");
        mkdirSync(backup);
        const result = runScript(root, [], { VERA_AGENT_BACKUP_DIR: backup });

        expect(result.status).toBe(0);
        expect(read(backup, "agent-notes/index.md")).toBe("index");
        expect(existsSync(join(backup, ".agent-notes", ".DS_Store"))).toBe(false);
        expect(existsSync(join(backup, "agent-notes", ".DS_Store"))).toBe(false);
        expect(existsSync(join(backup, "agent-notes", "memory", ".DS_Store")))
            .toBe(false);
        expect(existsSync(join(backup, ".claude", "rules", ".DS_Store")))
            .toBe(false);
    });

    test("skips missing sources and copies the rest", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");
        write(root, ".agent-notes/index.md", "index");

        const backup = join(root, "backup");
        mkdirSync(backup);
        const result = runScript(root, [], { VERA_AGENT_BACKUP_DIR: backup });

        expect(result.status).toBe(0);
        expect(read(backup, "AGENTS.local.md")).toBe("agents");
        expect(read(backup, "agent-notes/index.md")).toBe("index");
        expect(existsSync(join(backup, "CLAUDE.md"))).toBe(false);
        expect(existsSync(join(backup, ".claude"))).toBe(false);
        expect(existsSync(join(backup, ".vera"))).toBe(false);
    });

    test("falls back to the script's own checkout when git is unavailable", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");

        const backup = join(root, "backup");
        mkdirSync(backup);
        const result = runScript(root, [], {
            VERA_AGENT_BACKUP_DIR: backup,
            PATH: join(root, "no-bin"),
        });

        expect(result.status).toBe(0);
        expect(read(backup, "AGENTS.local.md")).toBe("agents");
    });

    test("run from a worktree, backs up the main checkout's files", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "main");
        write(root, ".agent-notes/index.md", "main note");
        runGit(root, ["init", "--quiet"]);
        runGit(root, ["add", "."]);
        commit(root, "init");

        const workspace = temporaryDirectory();
        const worktree = join(workspace, "worktree");
        runGit(root, ["worktree", "add", "--quiet", "-b", "topic", worktree]);
        write(worktree, "AGENTS.local.md", "stale worktree copy");
        write(worktree, ".agent-notes/memory/only-worktree.md", "not a source");

        const backup = join(workspace, "backup");
        mkdirSync(backup);
        const result = runScript(worktree, [], {
            VERA_AGENT_BACKUP_DIR: backup,
        });

        expect(result.status).toBe(0);
        expect(read(backup, "AGENTS.local.md")).toBe("main");
        expect(read(backup, "agent-notes/index.md")).toBe("main note");
        expect(existsSync(join(backup, "agent-notes", "memory", "only-worktree.md")))
            .toBe(false);
    });
});

describe("--auto", () => {
    test("exits 0 silently without VERA_AGENT_BACKUP_DIR", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");

        const result = runScript(root, ["--auto"]);

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
    });

    test("exits 0 silently when the backup root does not exist", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");
        const backup = join(root, "absent");

        const result = runScript(root, ["--auto"], {
            VERA_AGENT_BACKUP_DIR: backup,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        expect(existsSync(backup)).toBe(false);
    });

    test("keeps going when one destination cannot be written", () => {
        const root = temporaryProject();
        write(root, "CLAUDE.md", "root guidance");
        write(root, ".agent-notes/index.md", "index");

        const backup = join(root, "backup");
        const notes = join(backup, "agent-notes");
        mkdirSync(notes, { recursive: true });
        chmodSync(notes, 0o500);
        try {
            const result = runScript(root, ["--auto"], {
                VERA_AGENT_BACKUP_DIR: backup,
            });

            expect(result.status).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("");
            expect(read(backup, "CLAUDE.md")).toBe("root guidance");
            expect(existsSync(join(notes, "index.md"))).toBe(false);
        } finally {
            chmodSync(notes, 0o700);
        }
    });
});

describe("--prune", () => {
    test("removes backup files whose source is gone", () => {
        const root = temporaryProject();
        write(root, ".agent-notes/index.md", "index");
        write(root, ".vera/rules/paths.md", "rule");
        write(root, ".claude/rules/paths.md", "mirror rule");

        const backup = join(root, "backup");
        write(backup, "agent-notes/index.md", "index");
        write(backup, "agent-notes/gone.md", "gone");
        write(backup, ".vera/rules/paths.md", "rule");
        write(backup, ".vera/rules/gone.md", "gone");
        write(backup, ".claude/rules/gone.md", "gone");
        write(backup, "AGENTS.local.md", "no source, but not in a managed tree");

        const result = runScript(root, ["--prune"], {
            VERA_AGENT_BACKUP_DIR: backup,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("agent-notes/gone.md");
        expect(existsSync(join(backup, "agent-notes", "gone.md"))).toBe(false);
        expect(existsSync(join(backup, ".vera", "rules", "gone.md"))).toBe(false);
        expect(existsSync(join(backup, ".claude", "rules", "gone.md"))).toBe(false);
        expect(read(backup, "agent-notes/index.md")).toBe("index");
        expect(read(backup, ".vera/rules/paths.md")).toBe("rule");
        expect(existsSync(join(backup, "AGENTS.local.md"))).toBe(true);
    });

    test("refuses a subtree whose source is missing or empty", () => {
        const root = temporaryProject();
        write(root, ".vera/rules/paths.md", "rule");
        mkdirSync(join(root, ".claude", "rules"), { recursive: true });

        const backup = join(root, "backup");
        write(backup, "agent-notes/kept.md", "kept");
        write(backup, ".claude/rules/kept.md", "kept");

        const result = runScript(root, ["--prune"], {
            VERA_AGENT_BACKUP_DIR: backup,
        });

        expect(result.status).toBe(0);
        expect(read(backup, "agent-notes/kept.md")).toBe("kept");
        expect(read(backup, ".claude/rules/kept.md")).toBe("kept");
    });

    test("is never part of --auto", () => {
        const root = temporaryProject();
        write(root, ".agent-notes/index.md", "index");

        const backup = join(root, "backup");
        write(backup, "agent-notes/orphan.md", "orphan");

        const result = runScript(root, ["--auto"], {
            VERA_AGENT_BACKUP_DIR: backup,
        });

        expect(result.status).toBe(0);
        expect(existsSync(join(backup, "agent-notes", "orphan.md"))).toBe(true);
        expect(read(backup, "agent-notes/index.md")).toBe("index");
    });
});

describe("hooks", () => {
    test("exit 0 silently with nothing configured", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");
        installHooks(root);
        runGit(root, ["init", "--quiet"]);

        const environment = {
            GIT_CONFIG_GLOBAL: join(root, "absent.gitconfig"),
            GIT_CONFIG_NOSYSTEM: "1",
        };
        for (const hook of ["post-commit", "post-merge"]) {
            const result = runShell(
                join(root, "dev", "hooks", hook),
                [],
                root,
                environment,
            );
            expect(result.status).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("");
        }
    });

    test("back up when a backup directory is configured", () => {
        const root = temporaryProject();
        write(root, "AGENTS.local.md", "agents");
        installHooks(root);
        runGit(root, ["init", "--quiet"]);

        const backup = join(root, "backup");
        mkdirSync(backup);
        const result = runShell(
            join(root, "dev", "hooks", "post-commit"),
            [],
            root,
            { VERA_AGENT_BACKUP_DIR: backup },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        expect(read(backup, "AGENTS.local.md")).toBe("agents");
    });
});
