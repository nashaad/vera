import { beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    MEMORY_INDEX_FILENAME,
    memoryRoot,
    projectMemoryDir,
    userMemoryDir,
} from "../../src/engine/memory-paths.ts";
import { memoryWriteTool } from "../../src/tools/memory-write.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

// `homedir()` is resolved once per process, so the only way to point the memory
// root at a scratch directory is to set HOME before the process starts.
const ISOLATED = "VERA_MEMORY_WRITE_TEST_HOME";

if (process.env[ISOLATED] === undefined) {
    test("memory_write writes under an isolated HOME", async () => {
        const home = await mkdtemp(join(tmpdir(), "vera-memory-home-"));
        try {
            const child = Bun.spawn(["bun", "test", import.meta.path], {
                env: {
                    ...process.env,
                    HOME: home,
                    VERA_HOME: join(home, ".vera"),
                    [ISOLATED]: home,
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [code, stderr] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
            ]);
            expect(stderr.length > 0 ? stderr : "no output").toContain("0 fail");
            expect(code).toBe(0);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }, 60_000);
} else {
    registerTests();
}

function registerTests(): void {
    const signal = new AbortController().signal;
    const instructionRoot = "/repos/example";
    const runtime = new ToolRuntime(
        "/workspace",
        undefined,
        undefined,
        undefined,
        instructionRoot,
    );

    beforeEach(async () => {
        await rm(memoryRoot(), { recursive: true, force: true });
    });

    async function write(
        input: Record<string, unknown>,
    ): Promise<{ output: string; isError: boolean }> {
        const result = await memoryWriteTool.execute(input, runtime, signal);
        if (result.kind !== "output") {
            throw new Error("memory_write returned a non-output result");
        }
        return { output: result.output, isError: result.isError };
    }

    function read(directory: string, file: string): Promise<string> {
        return Bun.file(join(directory, file)).text();
    }

    test("a new topic file gets an index line", async () => {
        const result = await write({
            scope: "user",
            file: "build-commands.md",
            content: "Run `bun test` for the suite.",
            title: "Build commands",
            hook: "how to run the tests and the typechecker",
        });

        expect(result.isError).toBe(false);
        expect(result.output).toContain("index line added");
        expect(await read(userMemoryDir(), "build-commands.md"))
            .toBe("Run `bun test` for the suite.\n");
        expect(await read(userMemoryDir(), MEMORY_INDEX_FILENAME)).toBe(
            "- [Build commands](build-commands.md): how to run the tests and "
                + "the typechecker\n",
        );
    });

    test("project scope writes under the instruction root's directory", async () => {
        await write({
            scope: "project",
            file: "layout.md",
            content: "Engine never imports UI.",
            title: "Layout",
            hook: "where each layer lives",
        });

        const directory = projectMemoryDir(instructionRoot);
        expect(await read(directory, "layout.md"))
            .toBe("Engine never imports UI.\n");
        expect(await read(directory, MEMORY_INDEX_FILENAME))
            .toContain("- [Layout](layout.md): where each layer lives");
        expect(await Bun.file(join(userMemoryDir(), "layout.md")).exists())
            .toBe(false);
    });

    test("rewriting a topic replaces the body and refreshes its index line", async () => {
        await write({
            scope: "user",
            file: "editor.md",
            content: "Uses vim.",
            title: "Editor",
            hook: "which editor",
        });
        const result = await write({
            scope: "user",
            file: "editor.md",
            content: "Uses zed.",
            title: "Editor",
            hook: "which editor and why",
        });

        expect(result.output).toContain("index line updated");
        expect(await read(userMemoryDir(), "editor.md")).toBe("Uses zed.\n");
        expect(await read(userMemoryDir(), MEMORY_INDEX_FILENAME)).toBe(
            "- [Editor](editor.md): which editor and why\n",
        );
    });

    test("other index lines survive a topic rewrite", async () => {
        await write({
            scope: "user",
            file: "one.md",
            content: "First.",
            title: "One",
            hook: "the first thing",
        });
        await write({
            scope: "user",
            file: "two.md",
            content: "Second.",
            title: "Two",
            hook: "the second thing",
        });
        await write({
            scope: "user",
            file: "one.md",
            content: "First, revised.",
            title: "One",
            hook: "the first thing, revised",
        });

        expect(await read(userMemoryDir(), MEMORY_INDEX_FILENAME)).toBe(
            "- [One](one.md): the first thing, revised\n"
                + "- [Two](two.md): the second thing\n",
        );
    });

    test("the previous version is kept aside so a bad rewrite is recoverable", async () => {
        await write({
            scope: "user",
            file: "facts.md",
            content: "The good version.",
            title: "Facts",
            hook: "durable facts",
        });
        await write({
            scope: "user",
            file: "facts.md",
            content: "Oops, wiped it.",
            title: "Facts",
            hook: "durable facts",
        });

        expect(await read(userMemoryDir(), "facts.md"))
            .toBe("Oops, wiped it.\n");
        expect(await read(userMemoryDir(), "facts.md.bak"))
            .toBe("The good version.\n");
    });

    test("the backup holds only the version that was replaced", async () => {
        for (const content of ["one", "two", "three"]) {
            await write({
                scope: "user",
                file: "facts.md",
                content,
                title: "Facts",
                hook: "durable facts",
            });
        }

        expect(await read(userMemoryDir(), "facts.md")).toBe("three\n");
        expect(await read(userMemoryDir(), "facts.md.bak")).toBe("two\n");
    });

    test("the index can be rewritten directly", async () => {
        await write({
            scope: "user",
            file: "a.md",
            content: "A.",
            title: "A",
            hook: "the a thing",
        });
        await write({
            scope: "user",
            file: MEMORY_INDEX_FILENAME,
            content: "- [A](a.md): a tighter hook",
        });

        expect(await read(userMemoryDir(), MEMORY_INDEX_FILENAME))
            .toBe("- [A](a.md): a tighter hook\n");
        expect(await read(userMemoryDir(), `${MEMORY_INDEX_FILENAME}.bak`))
            .toBe("- [A](a.md): the a thing\n");
    });

    test("paths that escape the scope directory are refused", async () => {
        const escapes = [
            "../escape.md",
            "nested/topic.md",
            "/etc/passwd.md",
            "..%2Fescape.md",
            "topic.md/../../escape.md",
            "..",
        ];
        for (const file of escapes) {
            await expect(write({
                scope: "user",
                file,
                content: "x",
                title: "T",
                hook: "h",
            })).rejects.toThrow(/plain \.md filename/);
        }
        expect(await Bun.file(join(memoryRoot(), "escape.md")).exists())
            .toBe(false);
    });

    test("an oversize topic is refused rather than truncated", async () => {
        await expect(write({
            scope: "user",
            file: "huge.md",
            content: "x".repeat(33 * 1024),
            title: "Huge",
            hook: "too much",
        })).rejects.toThrow(/exceeds the 32,768 byte limit/);
        expect(await Bun.file(join(userMemoryDir(), "huge.md")).exists())
            .toBe(false);
    });

    test("an oversize index is refused rather than truncated", async () => {
        await expect(write({
            scope: "user",
            file: MEMORY_INDEX_FILENAME,
            content: "x".repeat(9 * 1024),
        })).rejects.toThrow(/exceeds the 8,192 byte limit/);
    });

    test("a topic that would overflow the index leaves both files alone", async () => {
        await write({
            scope: "user",
            file: MEMORY_INDEX_FILENAME,
            content: "- [Filler](filler.md): x".padEnd(8 * 1024 - 1, "x"),
        });

        await expect(write({
            scope: "user",
            file: "extra.md",
            content: "Small.",
            title: "Extra",
            hook: "one more",
        })).rejects.toThrow(/exceeds the 8,192 byte limit/);
        expect(await Bun.file(join(userMemoryDir(), "extra.md")).exists())
            .toBe(false);
    });

    test("a bad scope is refused", async () => {
        await expect(write({
            scope: "global",
            file: "a.md",
            content: "A.",
            title: "A",
            hook: "h",
        })).rejects.toThrow(/scope must be/);
    });

    test("a topic write without a hook is refused", async () => {
        await expect(write({
            scope: "user",
            file: "a.md",
            content: "A.",
            title: "A",
        })).rejects.toThrow(/string hook/);
    });

    test("the index warns once it passes the warn threshold", async () => {
        const result = await write({
            scope: "user",
            file: MEMORY_INDEX_FILENAME,
            content: "- [Filler](filler.md): x".padEnd(5 * 1024, "x"),
        });

        expect(result.output).toContain("should be trimmed");
    });
}
