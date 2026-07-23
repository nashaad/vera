import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBash } from "../../src/tools/bash.ts";

test("bash runs ordinary recursive deletion after engine permission", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));
    const target = join(workspace, "remove-me");
    await mkdir(target);

    try {
        const result = await runBash("rm -rf remove-me", workspace);

        expect(result).toEqual({
            kind: "output",
            output: "(no output)",
            isError: false,
        });
        await expect(stat(target)).rejects.toThrow();
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("bash still runs ordinary commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));

    try {
        const result = await runBash("printf 'safe command'", workspace);

        expect(result).toEqual({
            kind: "output",
            output: "safe command",
            isError: false,
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("bash stops promptly when its turn is aborted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));
    const controller = new AbortController();

    try {
        const startedAt = performance.now();
        const resultPromise = runBash(
            "sleep 5; printf 'too late'",
            workspace,
            controller.signal,
        );
        await Bun.sleep(25);
        controller.abort(new Error("Turn aborted"));
        const result = await resultPromise;

        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(result.isError).toBe(true);
        expect(result.output).not.toContain("too late");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("bash force-kills a command tree that ignores termination", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));
    const controller = new AbortController();

    try {
        const startedAt = performance.now();
        const resultPromise = runBash(
            "trap '' TERM; sleep 5; printf 'too late'",
            workspace,
            controller.signal,
        );
        await Bun.sleep(25);
        controller.abort(new Error("Turn aborted"));
        const result = await resultPromise;

        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(result.isError).toBe(true);
        expect(result.output).not.toContain("too late");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
