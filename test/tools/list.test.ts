import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listTool } from "../../src/tools/list.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import {
    decideToolPermission,
    extractPermissionActions,
} from "../../src/engine/permissions.ts";

test("list returns sorted top-level paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-list-"));
    try {
        await writeFile(join(workspace, "b.txt"), "");
        await writeFile(join(workspace, "a.txt"), "");
        await mkdir(join(workspace, "sub"));

        const result = await listTool.execute(
            { path: "." },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            const lines = result.output.split("\n");
            expect(lines).toEqual([...lines].sort());
            expect(result.output).toContain("a.txt");
            expect(result.output).toContain("b.txt");
            expect(result.output).toContain("sub");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("list treats an empty path as the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-list-"));
    try {
        await writeFile(join(workspace, "workspace-file.txt"), "");

        const result = await listTool.execute(
            { path: "" },
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

test("list respects recursive and glob filters", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-list-"));
    try {
        await mkdir(join(workspace, "sub"));
        await writeFile(join(workspace, "sub", "nested.ts"), "");
        await writeFile(join(workspace, "top.ts"), "");
        await writeFile(join(workspace, "top.md"), "");

        const result = await listTool.execute(
            { path: ".", recursive: true, glob: "*.ts" },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );

        expect(result.kind).toBe("output");
        if (result.kind === "output") {
            expect(result.output).toContain("nested.ts");
            expect(result.output).toContain("top.ts");
            expect(result.output).not.toContain("top.md");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("list caps entries and reports the window so the model can page", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-list-"));
    try {
        for (let i = 0; i < 10; i++) {
            await writeFile(join(workspace, `f${i}.txt`), "");
        }

        const first = await listTool.execute(
            { path: ".", max_results: 4 },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(first.kind).toBe("output");
        if (first.kind === "output") {
            expect(first.output).toContain("showing 1-4 of 10");
            expect(first.output).toContain("offset=4");
        }

        const second = await listTool.execute(
            { path: ".", max_results: 4, offset: 8 },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(second.kind).toBe("output");
        if (second.kind === "output") {
            expect(second.output).toContain("showing 9-10 of 10");
        }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("list past the end says so instead of looking empty", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-list-"));
    try {
        await writeFile(join(workspace, "only.txt"), "");

        const result = await listTool.execute(
            { path: ".", offset: 50 },
            new ToolRuntime(workspace),
            new AbortController().signal,
        );
        expect(result).toEqual({
            kind: "output",
            output: "(no entries at offset 50; 1 total)",
            isError: false,
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("list is a routine read allowed under every profile", () => {
    const workspace = "/Users/nash/Projects/vera";
    const homeDirectory = "/Users/nash";
    const call = {
        id: "call_1",
        name: "list",
        input: { path: "/Users/nash/Projects/other-repo" },
    };
    expect(extractPermissionActions({ toolCall: call, workspace, homeDirectory }))
        .toEqual([{
            tool: "list",
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

test("list with an empty path is a routine workspace read", () => {
    const workspace = "/Users/nash/Projects/vera";
    const call = { id: "call_1", name: "list", input: { path: "" } };

    expect(extractPermissionActions({
        toolCall: call,
        workspace,
        homeDirectory: "/Users/nash",
    })).toEqual([{
        tool: "list",
        verb: "read",
        path: workspace,
        scope: "workspace",
    }]);
    expect(decideToolPermission("ask", call, workspace).behavior).toBe("allow");
});
