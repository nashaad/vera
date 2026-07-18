import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
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
    toolDefinitionsForEffects,
} from "../../src/tools/execute.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

test("subagent is exposed only when the engine can apply effects", async () => {
    const ordinary = toolDefinitionsForEffects([]).map((tool) => tool.name);
    const withSubagent = toolDefinitionsForEffects([
        "spawn_subagent",
    ]).map((tool) => tool.name);
    const withAllEffects = toolDefinitionsForEffects([
        "spawn_subagent",
        "spawn_background_agent",
    ]).map((tool) => tool.name);

    expect(ordinary).not.toContain("subagent");
    expect(ordinary).not.toContain("background_agent");
    expect(withSubagent).toContain("subagent");
    expect(withSubagent).not.toContain("background_agent");
    expect(withAllEffects).toContain("subagent");
    expect(withAllEffects).toContain("background_agent");

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
        expect(writeResult.content[0]?.text).toBe("Wrote 15 bytes to notes.txt");
        expect(readResult).toMatchObject({
            role: "tool_result",
            toolCallId: "call_read",
            toolName: "read",
            isError: false,
        });
        expect(readResult.content[0]?.text).toBe("hello from Vera");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("file tools reject paths outside the workspace", async () => {
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
            { path: "../escape.txt", content: "no" },
        ), runtime);
        const symlinkRead = await executeToolCall(toolCall(
            "call_3",
            "read",
            { path: "outside-link/outside.txt" },
        ), runtime);
        const symlinkWrite = await executeToolCall(toolCall(
            "call_4",
            "write",
            { path: "outside-link/escape.txt", content: "no" },
        ), runtime);

        for (const result of [parentRead, parentWrite, symlinkRead, symlinkWrite]) {
            expect(result.isError).toBe(true);
            expect(result.content[0]?.text).toContain("Path is outside the workspace");
        }
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
