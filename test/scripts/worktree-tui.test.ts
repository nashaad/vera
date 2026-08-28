import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    resolveLinkedWorktreeRoot,
    worktreeRuntimeDirectory,
} from "../../scripts/worktree-tui.ts";

test("a worktree gets a stable runtime distinct from its neighbours", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-worktree-runtime-test-"));
    const first = join(root, "same name");
    const second = join(root, "other", "same name");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const firstRuntime = worktreeRuntimeDirectory(first, "/tmp");
    expect(worktreeRuntimeDirectory(first, "/tmp")).toBe(firstRuntime);
    expect(worktreeRuntimeDirectory(second, "/tmp")).not.toBe(firstRuntime);
    expect(firstRuntime).toMatch(
        /^\/tmp\/vera-worktrees(?:-\d+)?\/same-name-[a-f0-9]{10}$/,
    );
});

test("the launcher resolves a linked worktree from a nested directory", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-linked-worktree-test-"));
    const repository = join(root, "repository");
    const checkout = join(root, "checkout");
    mkdirSync(repository);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repository });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repository });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
        cwd: repository,
    });
    writeFileSync(join(repository, "tracked"), "fixture\n");
    Bun.spawnSync(["git", "add", "tracked"], { cwd: repository });
    Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: repository });
    Bun.spawnSync(["git", "worktree", "add", "-q", checkout], {
        cwd: repository,
    });
    mkdirSync(join(checkout, "nested"), { recursive: true });

    expect(resolveLinkedWorktreeRoot(join(checkout, "nested"))).toBe(
        realpathSync(checkout),
    );
});

test("the launcher refuses the main checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-main-checkout-test-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });

    expect(() => resolveLinkedWorktreeRoot(root)).toThrow(
        "tui:worktree requires a linked worktree",
    );
});
