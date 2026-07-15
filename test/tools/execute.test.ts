import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCallContent } from "../../src/model/types.ts";
import { executeToolCall } from "../../src/tools/execute.ts";

test("file tools read and write inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-files-"));

    try {
        const writeResult = await executeToolCall(toolCall(
            "call_write",
            "write",
            { path: "notes.txt", content: "hello from Vera" },
        ), workspace);
        const readResult = await executeToolCall(toolCall(
            "call_read",
            "read",
            { path: "notes.txt" },
        ), workspace);

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

    try {
        const parentRead = await executeToolCall(toolCall(
            "call_1",
            "read",
            { path: "../outside.txt" },
        ), workspace);
        const parentWrite = await executeToolCall(toolCall(
            "call_2",
            "write",
            { path: "../escape.txt", content: "no" },
        ), workspace);
        const symlinkRead = await executeToolCall(toolCall(
            "call_3",
            "read",
            { path: "outside-link/outside.txt" },
        ), workspace);
        const symlinkWrite = await executeToolCall(toolCall(
            "call_4",
            "write",
            { path: "outside-link/escape.txt", content: "no" },
        ), workspace);

        for (const result of [parentRead, parentWrite, symlinkRead, symlinkWrite]) {
            expect(result.isError).toBe(true);
            expect(result.content[0]?.text).toContain("Path is outside the workspace");
        }
    } finally {
        await rm(root, { recursive: true, force: true });
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
