import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containsRecursiveForceRm } from "../../src/tools/bash-danger.ts";
import { runBash } from "../../src/tools/bash.ts";

test("bash danger detector recognizes recursive-force rm forms", () => {
    const blockedCommands = [
        "rm -rf target",
        "rm -fr target",
        "rm -r -f target",
        "rm -f -R target",
        "rm --recursive --force target",
        "rm --force --recursive target",
        "pwd && /bin/rm -Rfv target",
        "MODE=cleanup rm -rf target",
        "command rm -rf target",
        "echo `rm -rf target`",
        "echo \"result: `rm -rf target`\"",
    ];

    for (const command of blockedCommands) {
        expect(containsRecursiveForceRm(command)).toBe(true);
    }
});

test("bash danger detector requires both active rm flags", () => {
    const allowedCommands = [
        "rm -r target",
        "rm -f target",
        "rm -r -- -f",
        "printf 'rm -rf target'",
    ];

    for (const command of allowedCommands) {
        expect(containsRecursiveForceRm(command)).toBe(false);
    }
});

test("bash blocks recursive-force rm before starting a subprocess", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));
    const target = join(workspace, "keep-me");
    await mkdir(target);

    try {
        const result = await runBash("rm -rf keep-me", workspace);

        expect(result).toEqual({
            output: "Blocked dangerous command: recursive-force rm is not allowed",
            isError: true,
        });
        expect((await stat(target)).isDirectory()).toBe(true);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("bash still runs ordinary commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));

    try {
        const result = await runBash("printf 'safe command'", workspace);

        expect(result).toEqual({ output: "safe command", isError: false });
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
