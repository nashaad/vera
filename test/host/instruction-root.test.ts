import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInstructionRoot } from "../../src/host/agent-registry.ts";

test("a directory outside any repository resolves to itself", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "vera-root-")));
    try {
        expect(resolveInstructionRoot(dir)).toEqual({
            path: dir,
            source: "workspace",
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a subdirectory of a repository resolves to the checkout", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "vera-root-")));
    try {
        spawnSync("git", ["init", "-q"], { cwd: dir });
        const nested = join(dir, "src", "engine");
        await mkdir(nested, { recursive: true });

        expect(resolveInstructionRoot(nested)).toEqual({
            path: dir,
            source: "git",
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a workspace is resolved once and remembered", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "vera-root-")));
    try {
        expect(resolveInstructionRoot(dir)).toEqual({
            path: dir,
            source: "workspace",
        });
        // The repository appears after the first answer, and the remembered
        // one stands: hundreds of restores must not spawn git hundreds of
        // times for the same directory.
        spawnSync("git", ["init", "-q"], { cwd: dir });
        expect(resolveInstructionRoot(dir)).toEqual({
            path: dir,
            source: "workspace",
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
