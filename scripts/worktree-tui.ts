#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRYPOINT = fileURLToPath(
    new URL("../clients/cli/main.ts", import.meta.url),
);

/** A stable private runtime for every linked checkout of Vera. */
export function worktreeRuntimeDirectory(
    worktreeRoot: string,
    temporaryRoot = "/tmp",
): string {
    const root = realpathSync(worktreeRoot);
    const slug = basename(root)
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "worktree";
    const identity = createHash("sha256").update(root).digest("hex").slice(0, 10);
    const owner = typeof process.getuid === "function"
        ? `vera-worktrees-${process.getuid()}`
        : "vera-worktrees";
    return join(temporaryRoot, owner, `${slug}-${identity}`);
}

/** Resolve the linked worktree the command was invoked anywhere inside. */
export function resolveLinkedWorktreeRoot(cwd: string): string {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        const reason = result.stderr.toString().trim();
        throw new Error(reason || `${cwd} is not inside a Git checkout`);
    }
    const root = realpathSync(result.stdout.toString().trim());
    if (!statSync(join(root, ".git")).isFile()) {
        throw new Error(
            `${root} is the main checkout; tui:worktree requires a linked worktree`,
        );
    }
    return root;
}

export async function runWorktreeTui(
    args: readonly string[],
    cwd = process.cwd(),
): Promise<number> {
    const worktreeRoot = resolveLinkedWorktreeRoot(cwd);
    const runtimeDirectory = worktreeRuntimeDirectory(worktreeRoot);
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });

    process.stderr.write(
        `Vera worktree runtime: ${runtimeDirectory}\n`,
    );
    const child = Bun.spawn(
        [process.execPath, CLI_ENTRYPOINT, ...args],
        {
            cwd: worktreeRoot,
            env: {
                ...process.env,
                VERA_RUNTIME_DIR: runtimeDirectory,
            },
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        },
    );
    return await child.exited;
}

if (import.meta.main) {
    try {
        process.exitCode = await runWorktreeTui(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(
            `Could not launch Vera's worktree TUI: ${
                error instanceof Error ? error.message : String(error)
            }\n`,
        );
        process.exitCode = 1;
    }
}
