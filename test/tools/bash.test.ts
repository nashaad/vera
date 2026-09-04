import { expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bashTool, runBash } from "../../src/tools/bash.ts";
import { processTool } from "../../src/tools/process.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

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

test("bash gives commands EOF instead of inheriting terminal input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-stdin-"));
    try {
        const result = await runBash(
            "if read value; then exit 7; fi",
            workspace,
            AbortSignal.timeout(2_000),
        );
        expect(result).toEqual({
            kind: "output",
            output: "(no output)",
            isError: false,
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("a blocking Git editor yields as an owned process", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-git-editor-"));
    const editor = join(workspace, "blocking-editor");
    const editorCalled = join(workspace, "editor-called");
    const runtime = new ToolRuntime(
        workspace,
        undefined,
        undefined,
        { GIT_EDITOR: editor },
    );
    try {
        await writeFile(join(workspace, "seed.txt"), "seed\n");
        await writeFile(
            editor,
            `#!/bin/sh\nprintf called > ${JSON.stringify(editorCalled)}\nsleep 60\n`,
        );
        await chmod(editor, 0o755);
        const setup = await runBash(
            "git init -q"
                + " && git config user.name Nash"
                + " && git config user.email nash@example.invalid"
                + " && git add seed.txt"
                + " && git -c commit.gpgSign=false commit -qm seed"
                + ` && git config core.editor ${JSON.stringify(editor)}`
                + " && git config tag.gpgSign true",
            workspace,
        );
        expect(setup.isError).toBe(false);

        const result = await bashTool.execute(
            { command: "git tag archive HEAD", yield_after: 0.05 },
            runtime,
            AbortSignal.timeout(2_000),
        );
        expect(result).toMatchObject({ kind: "output", isError: false });
        expect(result.kind).toBe("output");
        if (result.kind !== "output") throw new Error("expected tool output");
        expect(result.processId).toBeString();
        await until(async () => {
            try {
                return (await Bun.file(editorCalled).text()) === "called";
            } catch {
                return false;
            }
        });
        const killed = await processTool.execute({
            action: "kill",
            process_id: result.processId,
        }, runtime, new AbortController().signal);
        expect(killed).toMatchObject({ kind: "output", isError: false });
    } finally {
        await runtime.close();
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

test("a command that writes far past the capture limit still exits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));

    try {
        // 8 MiB, well past the 1 MiB budget, so the child would block on a
        // full pipe if the discarded bytes were not still being read.
        const result = await runBash(
            "yes 0123456789012345678901234567890123456789012345678901234567890123"
                + " | head -c 8388608; echo; echo TAILMARK",
            workspace,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(false);
            expect(result.output.startsWith("0123456789")).toBe(true);
            expect(result.output).toContain("bytes omitted from the middle of process output");
            expect(result.output.trimEnd().endsWith("TAILMARK")).toBe(true);
            expect(result.output.length).toBeLessThan(1024 * 1024);
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}, 30_000);

test("caller env layers over the inherited environment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));

    try {
        const bare = await runBash('printf "%s" "$VERA_TEST_ENV"', workspace);
        expect(bare.output).toBe("(no output)");

        const layered = await runBash(
            'printf "%s:%s" "$VERA_TEST_ENV" "$HOME"',
            workspace,
            undefined,
            { VERA_TEST_ENV: "layered" },
        );
        expect(layered.isError).toBe(false);
        expect(layered.output.startsWith("layered:")).toBe(true);
        expect(layered.output.length).toBeGreaterThan("layered:".length);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

async function until(
    predicate: () => Promise<boolean>,
    timeoutMs = 2_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error("condition did not hold in time");
        await Bun.sleep(10);
    }
}

test("runtime env does not leak between tool runtimes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-bash-"));
    const signal = new AbortController().signal;
    const withEnv = new ToolRuntime(
        workspace,
        undefined,
        undefined,
        { VERA_TEST_ENV: "session-a" },
    );
    const withoutEnv = new ToolRuntime(workspace);
    const command = { command: 'printf "%s" "$VERA_TEST_ENV"' };

    try {
        const first = await bashTool.execute(command, withEnv, signal);
        const second = await bashTool.execute(command, withoutEnv, signal);

        expect(first).toMatchObject({ output: "session-a" });
        expect(second).toMatchObject({ output: "(no output)" });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
