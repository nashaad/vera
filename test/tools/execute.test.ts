import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCallContent } from "../../src/model/types.ts";
import {
    executeToolCall,
    executeToolHandler,
    toolDefinitionsForCapabilities,
} from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { resolveFileToolPermissionCall } from "../../src/tools/files.ts";
import { editDiffPresentation } from "../../src/tools/diff-presentation.ts";

test("oversized edit diffs become bounded notices", () => {
    const before = Array.from(
        { length: 500 },
        (_, index) => `before ${index}`,
    ).join("\n");
    const after = Array.from(
        { length: 500 },
        (_, index) => `after ${index}`,
    ).join("\n");

    expect(editDiffPresentation("large.txt", before, after)).toEqual({
        kind: "tool_notice",
        text: expect.stringContaining("-500 +500 lines"),
    });
});

test("a destructive oversized diff notice points at the pre-image stash", () => {
    const before = Array.from(
        { length: 500 },
        (_, index) => `line ${index}`,
    ).join("\n");

    const destructive = editDiffPresentation(
        "large.txt",
        before,
        "stub",
        "/stash/session-1",
    );
    expect(destructive).toEqual({
        kind: "tool_notice",
        text: expect.stringContaining("pre-image saved in /stash/session-1"),
    });

    const grown = editDiffPresentation(
        "large.txt",
        before,
        `${before}\n${before}`,
        "/stash/session-1",
    );
    expect(grown).toEqual({
        kind: "tool_notice",
        text: expect.not.stringContaining("pre-image"),
    });
});

test("subagent is exposed only when the engine can apply effects", async () => {
    const ordinary = toolDefinitionsForCapabilities([]).map((tool) => tool.name);
    const withSubagent = toolDefinitionsForCapabilities([
        "spawn_subagent",
    ]).map((tool) => tool.name);
    const withAllEffects = toolDefinitionsForCapabilities([
        "spawn_subagent",
        "spawn_async_subagent",
        "message_subagent",
        "notify_parent",
    ]).map((tool) => tool.name);

    expect(ordinary).not.toContain("subagent");
    expect(ordinary).not.toContain("async_subagent");
    expect(withSubagent).toContain("subagent");
    expect(withSubagent).not.toContain("async_subagent");
    expect(withAllEffects).toContain("subagent");
    expect(withAllEffects).toContain("async_subagent");
    expect(withAllEffects).toContain("message_subagent");
    expect(withAllEffects).toContain("notify_parent");

    const result = await executeToolHandler(
        toolCall("call_subagent", "subagent", {
            description: "Trace the request path",
        }),
        new ToolRuntime("/workspace"),
        new AbortController().signal,
    );

    expect(result).toEqual({
        kind: "effect",
        effect: {
            type: "spawn_subagent",
            description: "Trace the request path",
        },
    });
});

test("file tools read and write inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-files-"));
    const runtime = new ToolRuntime(workspace);

    try {
        const writeResult = await executeToolCall(toolCall(
            "call_write",
            "write",
            { path: "notes.txt", content: "hello from Vera" },
        ), runtime);
        const readResult = await executeToolCall(toolCall(
            "call_read",
            "read",
            { path: "notes.txt" },
        ), runtime);

        expect(writeResult).toMatchObject({
            role: "tool_result",
            toolCallId: "call_write",
            toolName: "write",
            isError: false,
        });
        expect(writeResult.content[0]?.text).toBe(
            "Wrote 1 line (15 bytes) to notes.txt (new file)",
        );
        expect(readResult).toMatchObject({
            role: "tool_result",
            toolCallId: "call_read",
            toolName: "read",
            isError: false,
        });
        expect(readResult.content[0]?.text).toBe(
            "1\thello from Vera\n[vera] Showing lines 1-1 of 1.",
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("write presents a diff: all additions for a new file, changes on overwrite", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-write-diff-"));
    const runtime = new ToolRuntime(workspace);

    try {
        const created = await executeToolCall(toolCall(
            "call_write_new",
            "write",
            { path: "notes.txt", content: "alpha\nbeta\n" },
        ), runtime);
        expect(created.presentation).toMatchObject({
            kind: "unified_diff",
            path: "notes.txt",
        });
        if (created.presentation?.kind !== "unified_diff") {
            throw new Error("expected an inline write diff");
        }
        expect(created.presentation.patch).toContain("+alpha");
        expect(created.presentation.patch).toContain("+beta");
        expect(created.presentation.patch).not.toContain("-alpha");

        const overwritten = await executeToolCall(toolCall(
            "call_write_again",
            "write",
            { path: "notes.txt", content: "alpha\ngamma\n" },
        ), runtime);
        if (overwritten.presentation?.kind !== "unified_diff") {
            throw new Error("expected an inline overwrite diff");
        }
        expect(overwritten.presentation.patch).toContain("-beta");
        expect(overwritten.presentation.patch).toContain("+gamma");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("write and edit stash the pre-image before the first mutation", async () => {
    const workspace = await realpath(
        await mkdtemp(join(tmpdir(), "vera-files-")),
    );
    const captured: Array<{ path: string; content: string }> = [];
    const runtime = new ToolRuntime(workspace, async (path, content) => {
        captured.push({ path, content });
    });

    try {
        await executeToolCall(toolCall(
            "call_create",
            "write",
            { path: "notes.txt", content: "original" },
        ), runtime);
        expect(captured).toEqual([]);

        await executeToolCall(toolCall(
            "call_replace",
            "write",
            { path: "notes.txt", content: "replacement" },
        ), runtime);
        expect(captured).toEqual([
            { path: join(workspace, "notes.txt"), content: "original" },
        ]);

        await executeToolCall(toolCall(
            "call_edit",
            "edit",
            {
                path: "notes.txt",
                edits: [{ old_string: "replacement", new_string: "edited" }],
            },
        ), runtime);
        expect(captured[1]).toEqual({
            path: join(workspace, "notes.txt"),
            content: "replacement",
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("a failing pre-image recorder does not fail the write", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-files-"));
    const runtime = new ToolRuntime(workspace, () => {
        throw new Error("stash unavailable");
    });

    try {
        await executeToolCall(toolCall(
            "call_create",
            "write",
            { path: "notes.txt", content: "original" },
        ), runtime);
        const result = await executeToolCall(toolCall(
            "call_replace",
            "write",
            { path: "notes.txt", content: "replacement" },
        ), runtime);
        expect(result.isError).toBe(false);
        expect(await Bun.file(join(workspace, "notes.txt")).text())
            .toBe("replacement");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("file tool guidance describes its permission-gated path reach", () => {
    const definitions = toolDefinitionsForCapabilities([]);
    expect(definitions.find((tool) => tool.name === "read")?.description).toBe(
        "Read a UTF-8 text file at any path available to Vera. Relative "
            + "paths resolve from the workspace. Output is line-numbered as "
            + "`N<TAB>line`, starting from the requested offset. `offset` and "
            + "`limit` are 1-indexed line numbers; a read returns at most 1000 "
            + "lines and names the offset to continue with when more remain.",
    );
    expect(definitions.find((tool) => tool.name === "write")?.description).toBe(
        "Create a new UTF-8 text file, or completely replace an existing one. Replacement is total: any existing content not included in this call is destroyed. To modify an existing file (append, insert, or change part of it), use edit instead. Relative paths resolve from the workspace.",
    );
});

test("file tools execute resolved paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-files-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "outside.txt"), "secret");
    await symlink(root, join(workspace, "outside-link"));
    const runtime = new ToolRuntime(workspace);

    try {
        const parentRead = await executeToolCall(toolCall(
            "call_1",
            "read",
            { path: "../outside.txt" },
        ), runtime);
        const parentWrite = await executeToolCall(toolCall(
            "call_2",
            "write",
            { path: "../escape.txt", content: "parent" },
        ), runtime);
        const symlinkRead = await executeToolCall(toolCall(
            "call_3",
            "read",
            { path: "outside-link/outside.txt" },
        ), runtime);
        const symlinkWrite = await executeToolCall(toolCall(
            "call_4",
            "write",
            { path: "outside-link/symlink.txt", content: "symlink" },
        ), runtime);
        const parentEdit = await executeToolCall(toolCall(
            "call_5",
            "edit",
            {
                path: "../outside.txt",
                edits: [{ old_string: "secret", new_string: "edited" }],
            },
        ), runtime);

        expect(parentRead.isError).toBe(false);
        expect(parentRead.content[0]?.text).toBe(
            "1\tsecret\n[vera] Showing lines 1-1 of 1.",
        );
        expect(parentWrite.isError).toBe(false);
        expect(symlinkRead.isError).toBe(false);
        expect(symlinkRead.content[0]?.text).toBe(
            "1\tsecret\n[vera] Showing lines 1-1 of 1.",
        );
        expect(symlinkWrite.isError).toBe(false);
        expect(parentEdit.isError).toBe(false);
        expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("edited");
        expect(await readFile(join(root, "escape.txt"), "utf8")).toBe("parent");
        expect(await readFile(join(root, "symlink.txt"), "utf8")).toBe("symlink");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("file permission preflight resolves symlinks to their effective target", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-file-preflight-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "outside.txt"), "secret");
    await symlink(root, join(workspace, "outside-link"));

    try {
        const resolved = await resolveFileToolPermissionCall(workspace, {
            id: "call_1",
            name: "write",
            input: {
                path: "outside-link/outside.txt",
                content: "updated",
            },
        });
        expect(resolved.input.path).toBe(
            join(await realpath(root), "outside.txt"),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("edit applies ordered replacements after writing the file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-edit-"));
    const runtime = new ToolRuntime(workspace);

    try {
        await executeToolCall(toolCall(
            "call_write",
            "write",
            { path: "notes.txt", content: "alpha\n" },
        ), runtime);
        const result = await executeToolCall(toolCall(
            "call_edit",
            "edit",
            {
                path: "notes.txt",
                edits: [
                    { old_string: "alpha", new_string: "beta" },
                    { old_string: "beta", new_string: "gamma" },
                ],
            },
        ), runtime);

        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).toBe("Applied 2 edits to notes.txt");
        expect(result.presentation).toMatchObject({
            kind: "unified_diff",
            path: "notes.txt",
        });
        if (result.presentation?.kind !== "unified_diff") {
            throw new Error("expected an inline edit diff");
        }
        expect(result.presentation.patch).toContain("-alpha");
        expect(result.presentation.patch).toContain("+gamma");
        expect(await readFile(join(workspace, "notes.txt"), "utf8")).toBe("gamma\n");

        const followUp = await executeToolCall(toolCall(
            "call_edit_again",
            "edit",
            {
                path: "notes.txt",
                edits: [{ old_string: "gamma", new_string: "delta" }],
            },
        ), runtime);
        expect(followUp.isError).toBe(false);
        expect(await readFile(join(workspace, "notes.txt"), "utf8")).toBe("delta\n");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("edit batches are all-or-nothing when a later replacement fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-edit-"));
    const runtime = new ToolRuntime(workspace);
    const path = join(workspace, "notes.txt");
    await writeFile(path, "alpha beta\n");

    try {
        await executeToolCall(toolCall(
            "call_read",
            "read",
            { path: "notes.txt" },
        ), runtime);
        const result = await executeToolCall(toolCall(
            "call_edit",
            "edit",
            {
                path: "notes.txt",
                edits: [
                    { old_string: "alpha", new_string: "ALPHA" },
                    { old_string: "missing", new_string: "present" },
                ],
            },
        ), runtime);

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(
            "edits[1].old_string matched 0 times",
        );
        expect(await readFile(path, "utf8")).toBe("alpha beta\n");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("edit reports an ambiguous match count without changing the file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-edit-"));
    const runtime = new ToolRuntime(workspace);
    const path = join(workspace, "notes.txt");
    await writeFile(path, "same\nsame\n");

    try {
        await executeToolCall(toolCall(
            "call_read",
            "read",
            { path: "notes.txt" },
        ), runtime);
        const result = await executeToolCall(toolCall(
            "call_edit",
            "edit",
            {
                path: "notes.txt",
                edits: [{ old_string: "same", new_string: "changed" }],
            },
        ), runtime);

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(
            "edits[0].old_string matched 2 times",
        );
        expect(await readFile(path, "utf8")).toBe("same\nsame\n");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("edit rejects a stale read and leaves the newer content intact", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-edit-"));
    const runtime = new ToolRuntime(workspace);
    const path = join(workspace, "notes.txt");
    await writeFile(path, "before\n");

    try {
        await executeToolCall(toolCall(
            "call_read",
            "read",
            { path: "notes.txt" },
        ), runtime);
        await writeFile(path, "changed elsewhere\n");
        const result = await executeToolCall(toolCall(
            "call_edit",
            "edit",
            {
                path: "notes.txt",
                edits: [{ old_string: "before", new_string: "after" }],
            },
        ), runtime);

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe(
            "File changed since it was read: notes.txt",
        );
        expect(await readFile(path, "utf8")).toBe("changed elsewhere\n");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("edit rejects an empty batch and requires a prior read", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-edit-"));
    const runtime = new ToolRuntime(workspace);
    await writeFile(join(workspace, "notes.txt"), "before\n");

    try {
        const empty = await executeToolCall(toolCall(
            "call_empty",
            "edit",
            { path: "notes.txt", edits: [] },
        ), runtime);
        const unread = await executeToolCall(toolCall(
            "call_unread",
            "edit",
            {
                path: "notes.txt",
                edits: [{ old_string: "before", new_string: "after" }],
            },
        ), runtime);

        expect(empty.isError).toBe(true);
        expect(empty.content[0]?.text).toBe(
            "edit tool requires a non-empty edits array",
        );
        expect(unread.isError).toBe(true);
        expect(unread.content[0]?.text).toBe(
            "Read notes.txt before editing it",
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("edit rejects empty old_string and unsupported fields", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-edit-"));
    const runtime = new ToolRuntime(workspace);

    try {
        const emptyOldString = await executeToolCall(toolCall(
            "call_empty_string",
            "edit",
            {
                path: "notes.txt",
                edits: [{ old_string: "", new_string: "content" }],
            },
        ), runtime);
        const replaceAll = await executeToolCall(toolCall(
            "call_replace_all",
            "edit",
            {
                path: "notes.txt",
                edits: [{
                    old_string: "before",
                    new_string: "after",
                    replace_all: true,
                }],
            },
        ), runtime);

        expect(emptyOldString.isError).toBe(true);
        expect(emptyOldString.content[0]?.text).toBe(
            "edits[0].old_string must not be empty",
        );
        expect(replaceAll.isError).toBe(true);
        expect(replaceAll.content[0]?.text).toBe(
            "edits[0] does not allow replace_all",
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

function toolCall(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): ToolCallContent {
    return {
        type: "tool_call",
        id,
        name,
        input,
    };
}
