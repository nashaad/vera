import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCallContent } from "../../src/model/types.ts";
import { executeToolCall } from "../../src/tools/execute.ts";
import {
    ToolRuntime,
    type BoundFileCheckpointCapture,
} from "../../src/tools/runtime.ts";

test("write captures a new file as not previously existing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-capture-"));
    const captures: BoundFileCheckpointCapture[] = [];
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
            intendedContent: "fresh",
            tool: "write",
            userMessageId: "user-message-1",
        });
        expect(captures[0]?.path.endsWith("new.txt")).toBe(true);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("write captures the prior contents when overwriting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-capture-"));
    await writeFile(join(workspace, "note.txt"), "old text");
    const captures: BoundFileCheckpointCapture[] = [];
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
            intendedContent: "new text",
            tool: "write",
            userMessageId: "user-message-1",
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("edit captures the file contents as they were read", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-capture-"));
    await writeFile(join(workspace, "note.txt"), "alpha beta");
    const captures: BoundFileCheckpointCapture[] = [];
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
            intendedContent: "alpha gamma",
            tool: "edit",
            userMessageId: "user-message-1",
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("checkpoint capture requires an active user-message boundary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-capture-"));
    const runtime = new ToolRuntime(workspace, {
        recordCheckpoint: async () => {},
    });

    try {
        await expect(runtime.recordCheckpoint({
            path: join(workspace, "note.txt"),
            existedBefore: true,
            priorContent: "before",
            intendedContent: "after",
            tool: "write",
        })).rejects.toThrow("without a user-message boundary");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

function runtimeWith(
    workspace: string,
    captures: BoundFileCheckpointCapture[],
): ToolRuntime {
    const runtime = new ToolRuntime(workspace, {
        recordCheckpoint: async (capture) => {
            captures.push(capture);
        },
    });
    runtime.beginCheckpointBoundary("user-message-1");
    return runtime;
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
