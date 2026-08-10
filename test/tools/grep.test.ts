import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { grepTool } from "../../src/tools/grep.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import {
    decideToolPermission,
    extractPermissionActions,
} from "../../src/engine/permissions.ts";

test("grep finds matches and defaults to files_with_matches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        await writeFile(join(workspace, "a.txt"), "hello world\n");
        await writeFile(join(workspace, "b.txt"), "nothing here\n");

        const result = await grepTool.execute(
            { pattern: "hello", path: "." },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result).toMatchObject({ kind: "output", isError: false });
        if (result.kind === "output") {
            expect(result.output).toContain("a.txt");
            expect(result.output).not.toContain("b.txt");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep treats an empty path as the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        await writeFile(join(workspace, "workspace-file.txt"), "needle\n");

        const result = await grepTool.execute(
            { pattern: "needle", path: "" },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result).toMatchObject({ kind: "output", isError: false });
        if (result.kind === "output") {
            expect(result.output).toContain("workspace-file.txt");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep content mode reports the matching line", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        await writeFile(join(workspace, "a.txt"), "one\ntwo\nthree\n");

        const result = await grepTool.execute(
            { pattern: "two", path: ".", output_mode: "content" },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.output).toContain("two");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep with no matches is not an error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        await writeFile(join(workspace, "a.txt"), "hello\n");

        const result = await grepTool.execute(
            { pattern: "nonexistent-pattern-xyz", path: "." },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result).toEqual({
            kind: "output",
            output: "(no matches)",
            isError: false,
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep caps results and reports the window so the model can page", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        const lines = Array.from({ length: 10 }, (_, i) => `match ${i}`);
        await writeFile(join(workspace, "a.txt"), `${lines.join("\n")}\n`);

        const first = await grepTool.execute(
            {
                pattern: "match",
                path: ".",
                output_mode: "content",
                max_results: 4,
            },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(first.kind).toBe("output");
        if (first.kind === "output") {
            expect(first.output).toContain("showing 1-4 of 10");
            expect(first.output).toContain("offset=4");
            expect(first.output).toContain("match 0");
            expect(first.output).not.toContain("match 4");
        }

        const second = await grepTool.execute(
            {
                pattern: "match",
                path: ".",
                output_mode: "content",
                max_results: 4,
                offset: 4,
            },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(second.kind).toBe("output");
        if (second.kind === "output") {
            expect(second.output).toContain("match 4");
            expect(second.output).not.toContain("match 0");
            expect(second.output).toContain("showing 5-8 of 10");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep passes context lines through to ripgrep", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        await writeFile(join(workspace, "a.txt"), "before\ntarget\nafter\n");

        const result = await grepTool.execute(
            {
                pattern: "target",
                path: ".",
                output_mode: "content",
                context: 1,
            },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.output).toContain("before");
            expect(result.output).toContain("after");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep type filter restricts the search to that language", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        await writeFile(join(workspace, "a.ts"), "needle\n");
        await writeFile(join(workspace, "b.md"), "needle\n");

        const result = await grepTool.execute(
            { pattern: "needle", path: ".", type: "ts" },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.output).toContain("a.ts");
            expect(result.output).not.toContain("b.md");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep is a routine read allowed under every profile, even outside the workspace", () => {
    const workspace = "/Users/nash/Projects/vera";
    const homeDirectory = "/Users/nash";
    const call = {
        id: "call_1",
        name: "grep",
        input: { pattern: "foo", path: "/Users/nash/Projects/other-repo" },
    };
    expect(extractPermissionActions({ toolCall: call, workspace, homeDirectory }))
        .toEqual([{
            tool: "grep",
            verb: "read",
            path: "/Users/nash/Projects/other-repo",
            scope: "outside_workspace",
        }]);
    for (const mode of ["ask", "auto", "full_access"] as const) {
        expect(
            decideToolPermission(mode, call, workspace, [], { homeDirectory })
                .behavior,
        ).toBe("allow");
    }
});

test("grep with an empty path is a routine workspace read", () => {
    const workspace = "/Users/nash/Projects/vera";
    const call = {
        id: "call_1",
        name: "grep",
        input: { pattern: "needle", path: "" },
    };

    expect(extractPermissionActions({
        toolCall: call,
        workspace,
        homeDirectory: "/Users/nash",
    })).toEqual([{
        tool: "grep",
        verb: "read",
        path: workspace,
        scope: "workspace",
    }]);
    expect(decideToolPermission("ask", call, workspace).behavior).toBe("allow");
});

test("missing ripgrep produces a clean error, never a bash fallback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    const originalPath = process.env.PATH;
    try {
        process.env.PATH = "";
        const result = await grepTool.execute(
            { pattern: "hello", path: "." },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.isError).toBe(true);
            expect(result.output).toContain("ripgrep");
        }
    } finally {
        process.env.PATH = originalPath;
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep caps a very long matching line and says so", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        await writeFile(join(workspace, "a.txt"), `${"x".repeat(64 * 1024)} needle\n`);

        const result = await grepTool.execute(
            { pattern: "needle", path: ".", output_mode: "content" },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.output).toContain("[vera] line truncated");
            expect(result.output).toContain("long line cut to");
            expect(result.output.length).toBeLessThan(8 * 1024);
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("grep keeps only the requested window of a large result set", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-grep-"));
    try {
        const lines = Array.from({ length: 3000 }, (_, index) => `match ${index}`);
        await writeFile(join(workspace, "a.txt"), `${lines.join("\n")}\n`);

        const result = await grepTool.execute(
            { pattern: "match", path: ".", output_mode: "content", max_results: 5 },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.output).toContain("showing 1-5 of 3000");
            expect(result.output).toContain("pass offset=5 for more");
            expect(result.output.split("\n").length).toBeLessThan(10);
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
