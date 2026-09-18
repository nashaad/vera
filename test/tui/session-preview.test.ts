import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage } from "../../src/model/types.ts";
import {
    readSessionPreview,
    SESSION_PREVIEW_EMPTY,
    sessionPreviewLines,
} from "../../clients/tui/session-preview.ts";

test("a preview keeps the last user and assistant turns", () => {
    expect(sessionPreviewLines([
        { kind: "user", text: "first" },
        { kind: "tool", tool: "bash", args: {} },
        { kind: "assistant", text: "second" },
    ])).toEqual([
        "You",
        "first",
        "",
        "Vera",
        "second",
    ]);
});

test("a conversation with no messages says so", () => {
    expect(sessionPreviewLines([
        { kind: "tool", tool: "bash", args: {} },
    ])).toEqual([SESSION_PREVIEW_EMPTY]);
});

test("readSessionPreview paints the saved transcript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-preview-"));
    const path = join(directory, "chat.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: 1,
            id: "preview-session",
            timestamp: "2026-09-17T00:00:00.000Z",
            cwd: "/work/vera",
        }),
        JSON.stringify({
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-09-17T00:00:00.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "whats 2 + 2" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "assistant-1",
            parentId: "user-1",
            timestamp: "2026-09-17T00:00:01.000Z",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "4" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        }),
    ].join("\n") + "\n");

    expect(await readSessionPreview(path)).toEqual([
        "You",
        "whats 2 + 2",
        "",
        "Vera",
        "4",
    ]);
});
