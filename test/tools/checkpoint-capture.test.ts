import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCallContent } from "../../src/model/types.ts";
import { executeToolCall } from "../../src/tools/execute.ts";
import {
    ToolRuntime,
    type FileCheckpointCapture,
} from "../../src/tools/runtime.ts";

test("write captures a new file as not previously existing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-capture-"));
    const captures: FileCheckpointCapture[] = [];
    const runtime = runtimeWith(workspace, captures);

    try {
        await executeToolCall(
            toolCall("call_write", "write", {
                path: "new.txt",
                content: "fresh",
            }),
            runtime,
        );

        expect(captures).toHaveLength(1);
        expect(captures[0]).toMatchObject({
            existedBefore: false,
            priorContent: "",
            tool: "write",
        });
        expect(captures[0]?.path.endsWith("new.txt")).toBe(true);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("write captures the prior contents when overwriting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-capture-"));
    await writeFile(join(workspace, "note.txt"), "old text");
    const captures: FileCheckpointCapture[] = [];
    const runtime = runtimeWith(workspace, captures);

    try {
        await executeToolCall(
            toolCall("call_write", "write", {
                path: "note.txt",
                content: "new text",
            }),
            runtime,
        );

        expect(captures[0]).toMatchObject({
            existedBefore: true,
            priorContent: "old text",
            tool: "write",
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("edit captures the file contents as they were read", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-capture-"));
    await writeFile(join(workspace, "note.txt"), "alpha beta");
    const captures: FileCheckpointCapture[] = [];
    const runtime = runtimeWith(workspace, captures);

    try {
        await executeToolCall(
            toolCall("call_read", "read", { path: "note.txt" }),
            runtime,
        );
        await executeToolCall(
            toolCall("call_edit", "edit", {
                path: "note.txt",
                edits: [{ old_string: "beta", new_string: "gamma" }],
            }),
            runtime,
        );

        expect(captures).toHaveLength(1);
        expect(captures[0]).toMatchObject({
            existedBefore: true,
            priorContent: "alpha beta",
            tool: "edit",
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

function runtimeWith(
    workspace: string,
    captures: FileCheckpointCapture[],
): ToolRuntime {
    return new ToolRuntime(workspace, {
        recordCheckpoint: async (capture) => {
            captures.push(capture);
        },
    });
}

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
