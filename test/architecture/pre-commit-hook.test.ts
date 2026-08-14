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
