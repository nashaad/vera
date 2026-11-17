import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TITLE_SCRIPT = fileURLToPath(new URL("../../dev/ci/check-pr-title.sh", import.meta.url));
const PATHS_SCRIPT = fileURLToPath(new URL("../../dev/ci/check-protected-paths.sh", import.meta.url));
const directories: string[] = [];

const gitEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
};
for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
]) {
    delete gitEnvironment[key];
}

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-pr-checks-"));
    directories.push(directory);
    return directory;
}

function runScript(script: string, args: string[], cwd: string): SpawnSyncReturns<string> {
    return spawnSync(script, args, { cwd, encoding: "utf8", env: gitEnvironment });
}

function git(root: string, ...args: string[]): string {
    const result = spawnSync("git", [
        "-c", "core.hooksPath=/dev/null",
        "-c", "user.name=Test",
        "-c", "user.email=test@example.com",
        ...args,
    ], { cwd: root, encoding: "utf8", env: gitEnvironment });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

function write(root: string, path: string, content: string): void {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

function commit(root: string): string {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "test commit");
    return git(root, "rev-parse", "HEAD");
}

function repository(): { root: string; base: string } {
    const root = temporaryDirectory();
    git(root, "init", "--quiet");
    write(root, "src/engine/existing.ts", "engine\n");
    write(root, "test/engine/existing.test.ts", "engine test\n");
    write(root, "test/locked/existing.test.ts", "locked\n");
    write(root, "other.txt", "other\n");
    return { root, base: commit(root) };
}

function checkPaths(root: string, base: string): SpawnSyncReturns<string> {
    return runScript(PATHS_SCRIPT, [base, commit(root)], root);
}

describe("pull request title", () => {
    test("@core accepts a conventional title", () => {
        const result = runScript(TITLE_SCRIPT, ["feat: add a check"], temporaryDirectory());
        expect(result.status).toBe(0);
    });

    test("@core reports the hook error for a non-conventional title", () => {
        const result = runScript(TITLE_SCRIPT, ["add a check"], temporaryDirectory());
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("not a Conventional Commit");
    });

    test("@core rejects a title over 72 characters", () => {
        const result = runScript(TITLE_SCRIPT, [`feat: ${"a".repeat(67)}`], temporaryDirectory());
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("longer than 72 characters");
    });

    test("@core treats shell metacharacters in titles as text", () => {
        const root = temporaryDirectory();
        const title = 'fix: "\' `touch title-ran` $(touch title-ran)';
        const result = runScript(TITLE_SCRIPT, [title], root);
        expect(result.status).toBe(0);
        expect(existsSync(join(root, "title-ran"))).toBe(false);
    });
});

describe("pull request protected paths", () => {
    for (const path of ["src/engine/existing.ts", "test/engine/existing.test.ts"]) {
        test(`@core rejects changes to ${path}`, () => {
            const { root, base } = repository();
            write(root, path, "changed\n");
            const result = checkPaths(root, base);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(path);
            expect(result.stderr).toContain("maintainer approval of the exact diff");
        });
    }

    test("@core rejects adding an engine file", () => {
        const { root, base } = repository();
        write(root, "src/engine/new.ts", "new\n");
        const result = checkPaths(root, base);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("src/engine/new.ts");
    });

    test("@core allows adding a locked journey", () => {
        const { root, base } = repository();
        write(root, "test/locked/new.test.ts", "new\n");
        expect(checkPaths(root, base).status).toBe(0);
    });

    test("@core rejects modifying a locked journey", () => {
        const { root, base } = repository();
        write(root, "test/locked/existing.test.ts", "changed\n");
        const result = checkPaths(root, base);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("test/locked/existing.test.ts");
        expect(result.stderr).toContain("maintainer approval of the exact diff");
    });

    test("@core lists engine and locked journey changes together", () => {
        const { root, base } = repository();
        write(root, "src/engine/existing.ts", "changed\n");
        write(root, "test/locked/existing.test.ts", "changed\n");
        const result = checkPaths(root, base);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("src/engine/existing.ts");
        expect(result.stderr).toContain("test/locked/existing.test.ts");
    });

    test("@core rejects moving a locked journey elsewhere", () => {
        const { root, base } = repository();
        renameSync(join(root, "test/locked/existing.test.ts"), join(root, "moved.test.ts"));
        const result = checkPaths(root, base);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("test/locked/existing.test.ts");
    });

    test("@core rejects changing the type of a locked journey", () => {
        const { root, base } = repository();
        const path = join(root, "test/locked/existing.test.ts");
        rmSync(path);
        symlinkSync("../../other.txt", path);
        const result = checkPaths(root, base);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("test/locked/existing.test.ts");
    });

    test("@core allows changes elsewhere", () => {
        const { root, base } = repository();
        write(root, "other.txt", "changed\n");
        expect(checkPaths(root, base).status).toBe(0);
    });

    test("@core compares protected paths from the branch point", () => {
        const { root } = repository();
        git(root, "branch", "pull-request");
        write(root, "src/engine/existing.ts", "base branch change\n");
        const base = commit(root);

        git(root, "checkout", "--quiet", "pull-request");
        write(root, "other.txt", "pull request change\n");
        const unrelatedHead = commit(root);
        const unrelated = runScript(PATHS_SCRIPT, [base, unrelatedHead], root);
        expect(unrelated.status).toBe(0);

        write(root, "src/engine/existing.ts", "pull request engine change\n");
        const protectedHead = commit(root);
        const protectedChange = runScript(PATHS_SCRIPT, [base, protectedHead], root);
        expect(protectedChange.status).toBe(1);
        expect(protectedChange.stderr).toContain("src/engine/existing.ts");
    });

    test("@core fails closed when git cannot inspect the diff", () => {
        const { root, base } = repository();
        const result = runScript(PATHS_SCRIPT, ["missing-base", base], root);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("could not inspect engine changes");
    });
});
