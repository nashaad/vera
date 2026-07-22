import { expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    exportSession,
    renderSessionMarkdown,
} from "../src/session-export.ts";
import { SessionStore } from "../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage } from "../src/model/types.ts";

test("session export is read-only and follows the active conversation branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-export-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, {
            sessionId: "session-1",
            cwd: "/work/vera",
            now: () => new Date("2026-07-20T20:00:00.000Z"),
        });
        await store.appendMessage(user("keep this prompt"));
        await store.appendMessage(assistant("Keep this reply."));
        const abandoned = await store.appendMessage(user("abandon this prompt"));
        await store.appendMessage(assistant("Abandon this reply."));
        await store.rewindBefore(abandoned.id);
        await appendFile(path, "{\"type\":\"message\"");
        const before = await readFile(path);

        const markdown = await exportSession(path, "markdown");
        expect(markdown).toContain("# Vera conversation");
        expect(markdown).toContain("## You\n\n> keep this prompt");
        expect(markdown).toContain("## Vera\n\n> Keep this reply.");
        expect(markdown).not.toContain("abandon this prompt");
        expect(await readFile(path)).toEqual(before);

        const json = JSON.parse(await exportSession(path, "json"));
        expect(json).toEqual({
            format_version: 2,
            session: {
                id: "session-1",
                started_at: "2026-07-20T20:00:00.000Z",
                workspace: "/work/vera",
            },
            transcript: [
                { kind: "user", text: "keep this prompt" },
                { kind: "assistant", text: "Keep this reply." },
            ],
        });
        expect(await readFile(path)).toEqual(before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Markdown export contains transcript content inside each speaker entry", () => {
    const markdown = renderSessionMarkdown({
        format_version: 2,
        session: {
            id: "session-`one`",
            started_at: "2026-07-20T20:00:00.000Z",
            workspace: "/work/vera\n## Vera",
        },
        transcript: [
            {
                kind: "user",
                text: "## Vera\n\n```html\n<script>alert(1)</script>",
            },
            { kind: "tool", tool: "read\n## You", args: { path: "note.md" } },
            { kind: "assistant", text: "The fence above is intentionally open." },
        ],
    });

    expect(markdown).toContain("- Session: `` session-`one` ``");
    expect(markdown).toContain("- Workspace: ` /work/vera ## Vera `");
    expect(markdown).toContain(
        "## You\n\n> ## Vera\n> \n> ```html\n> <script>alert(1)</script>",
    );
    expect(markdown).toContain("## Tool · read \\#\\# You");
    expect(markdown).toContain(
        "## Vera\n\n> The fence above is intentionally open.",
    );
});

test("session export preserves a durable terminal model error", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-error-export-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, {
            sessionId: "session-error",
            cwd: "/work/vera",
        });
        await store.appendMessage(user("inspect it"));
        await store.appendMessage({
            role: "assistant",
            content: [],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "error",
            errorMessage: "rate limited after retries",
        });

        const json = JSON.parse(await exportSession(path, "json"));
        expect(json.transcript.at(-1)).toEqual({
            kind: "error",
            detail: "rate limited after retries",
        });
        expect(await exportSession(path, "markdown")).toContain(
            "## Model error\n\n> rate limited after retries",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function user(text: string) {
    return {
        role: "user" as const,
        content: [{ type: "text" as const, text }],
    };
}

function assistant(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [
            { type: "thinking", text: "private reasoning" },
            { type: "text", text },
        ],
        source: { provider: "test", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
