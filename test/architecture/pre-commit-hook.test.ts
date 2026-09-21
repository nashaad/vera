import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOOK = join(process.cwd(), "dev/hooks/pre-commit");

interface CheckResult {
    readonly accepted: boolean;
    readonly said: string;
}

interface CheckOptions {
    readonly approval?: string;
    readonly content?: string;
}

function check(
    paths: readonly string[],
    options: CheckOptions = {},
): CheckResult {
    const directory = mkdtempSync(join(tmpdir(), "vera-pre-commit-"));

    try {
        runGit(directory, "init", "--quiet");
        for (const path of paths) {
            const absolutePath = join(directory, path);
            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, options.content ?? `${path}\n`);
        }
        runGit(directory, "add", ".");

        const result = Bun.spawnSync(["sh", HOOK], {
            cwd: directory,
            env: {
                ...process.env,
                VERA_ENGINE_CHANGE_APPROVAL: options.approval ?? "",
            },
        });
        return {
            accepted: result.exitCode === 0,
            said: new TextDecoder().decode(result.stderr),
        };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function runGit(directory: string, ...args: readonly string[]): void {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory });
    if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
    }
}

test("an extension-only commit passes without approval", () => {
    expect(check([
        "extensions/example/extension.ts",
        "test/extensions/example.test.ts",
    ]).accepted).toBe(true);
});

test("engine source and tests require explicit maintainer approval", () => {
    const result = check([
        "src/engine/run-turn.ts",
        "test/engine/run-turn.test.ts",
    ]);

    expect(result.accepted).toBe(false);
    expect(result.said).toContain("src/engine/run-turn.ts");
    expect(result.said).toContain("test/engine/run-turn.test.ts");
    expect(result.said).toContain("New capabilities belong in extensions");
    expect(result.said).toContain("Generic approval");
});

test("the printed approval permits only that staged engine change", () => {
    const paths = ["src/engine/run-turn.ts"];
    const denied = check(paths);
    const approval = denied.said.match(
        /VERA_ENGINE_CHANGE_APPROVAL=([0-9a-f]+)/,
    )?.[1];

    expect(approval).toBeDefined();
    expect(check(paths, { approval }).accepted).toBe(true);
    expect(check(paths, { approval, content: "changed contents\n" }).accepted)
        .toBe(false);
    expect(check(
        [...paths, "test/engine/run-turn.test.ts"],
        { approval },
    ).accepted).toBe(false);
});

test("different blobs with the same abbreviated ID need different approval", () => {
    const paths = ["src/engine/same.ts"];
    const first = check(paths, { content: "payload-017814\n" });
    const approval = first.said.match(
        /VERA_ENGINE_CHANGE_APPROVAL=([0-9a-f]+)/,
    )?.[1];

    expect(approval).toBeDefined();
    expect(check(paths, {
        approval,
        content: "payload-124846\n",
    }).accepted).toBe(false);
});

test("a Git inspection error fails closed", () => {
    const result = Bun.spawnSync(["sh", HOOK], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            GIT_INDEX_FILE: "/dev/null",
            VERA_ENGINE_CHANGE_APPROVAL: "",
        },
    });

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr))
        .toContain("could not inspect staged engine changes");
});

interface LockedChange {
    readonly write?: Readonly<Record<string, string>>;
    readonly remove?: readonly string[];
    readonly approval?: string;
}

function checkLocked(committed: Readonly<Record<string, string>>, change: LockedChange): CheckResult {
    const directory = mkdtempSync(join(tmpdir(), "vera-pre-commit-locked-"));

    try {
        runGit(directory, "init", "--quiet");
        runGit(directory, "config", "user.email", "test@example.com");
        runGit(directory, "config", "user.name", "test");
        for (const [path, content] of Object.entries(committed)) {
            const absolutePath = join(directory, path);
            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, content);
        }
        runGit(directory, "add", ".");
        runGit(directory, "commit", "--quiet", "--no-verify", "-m", "base");
        for (const [path, content] of Object.entries(change.write ?? {})) {
            const absolutePath = join(directory, path);
            mkdirSync(dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, content);
        }
        for (const path of change.remove ?? []) runGit(directory, "rm", "--quiet", path);
        runGit(directory, "add", ".");

        const result = Bun.spawnSync(["sh", HOOK], {
            cwd: directory,
            env: {
                ...process.env,
                VERA_ENGINE_CHANGE_APPROVAL: "",
                VERA_LOCKED_CHANGE_APPROVAL: change.approval ?? "",
            },
        });
        return {
            accepted: result.exitCode === 0,
            said: new TextDecoder().decode(result.stderr),
        };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

const LOCKED_TIMEOUT_MS = 30_000;
const LOCKED = "test/locked/model-switch.journey.test.ts";

test("adding a locked journey needs no approval", () => {
    expect(checkLocked({ "README.md": "x\n" }, { write: { [LOCKED]: "new\n" } }).accepted).toBe(true);
}, LOCKED_TIMEOUT_MS);

test("editing a locked journey is refused without approval", () => {
    const result = checkLocked({ [LOCKED]: "decided\n" }, { write: { [LOCKED]: "weakened\n" } });

    expect(result.accepted).toBe(false);
    expect(result.said).toContain(LOCKED);
    expect(result.said).toContain("the code is the bug");
}, LOCKED_TIMEOUT_MS);

test("deleting or moving a locked journey is refused", () => {
    expect(checkLocked({ [LOCKED]: "decided\n" }, { remove: [LOCKED] }).accepted).toBe(false);
    expect(checkLocked({ [LOCKED]: "decided\n" }, {
        remove: [LOCKED],
        write: { "test/tui/model-switch.test.ts": "decided\n" },
    }).accepted).toBe(false);
}, LOCKED_TIMEOUT_MS);

test("the printed locked approval permits only that staged change", () => {
    const committed = { [LOCKED]: "decided\n" };
    const denied = checkLocked(committed, { write: { [LOCKED]: "revised\n" } });
    const approval = denied.said.match(/VERA_LOCKED_CHANGE_APPROVAL=([0-9a-f]+)/)?.[1];

    expect(approval).toBeDefined();
    expect(checkLocked(committed, { write: { [LOCKED]: "revised\n" }, approval }).accepted).toBe(true);
    expect(checkLocked(committed, { write: { [LOCKED]: "other\n" }, approval }).accepted).toBe(false);
}, LOCKED_TIMEOUT_MS);

test("an engine approval does not unlock a locked journey", () => {
    const committed = { [LOCKED]: "decided\n", "src/engine/run-turn.ts": "a\n" };
    const change = { [LOCKED]: "revised\n", "src/engine/run-turn.ts": "b\n" };
    const denied = checkLocked(committed, { write: change });
    const locked = denied.said.match(/VERA_LOCKED_CHANGE_APPROVAL=([0-9a-f]+)/)?.[1];

    expect(denied.said).toContain("VERA_ENGINE_CHANGE_APPROVAL=");
    expect(checkLocked(committed, { write: change, approval: locked }).accepted).toBe(false);
}, LOCKED_TIMEOUT_MS);
