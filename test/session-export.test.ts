import { expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    exportSession,
    renderSessionMarkdown,
    type SessionExport,
} from "../src/session-export.ts";
import { readSessionSnapshot, SessionStore } from "../src/store/session-store.ts";
import { projectTranscript } from "../src/engine/protocol.ts";
import { walkSessionTranscript } from "../src/session-transcript.ts";
import { emptyUsage, type AssistantMessage } from "../src/model/types.ts";

test("streamed exports match the full projection byte for byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-export-stream-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "session", cwd: root });
        await store.appendMessage(user("first"));
        await store.appendMessage({ role: "user", internal: true, content: [{ type: "text", text: "hidden" }] });
        await store.appendHarnessMessage("delayed", "soft");
        const second = await store.appendMessage(user("second"));
        const reply = await store.appendMessage(assistant("reply"));
        const abandoned = await store.appendMessage(user("abandoned"));
        await store.appendMessage(assistant("abandoned reply"));
        await store.rewindBefore(abandoned.id);
        await store.appendCompaction({ boundaryMessageId: second.id, firstRetainedMessageId: reply.id,
            projection: [user("summary")], measured: { inputTokens: 10, estimated: true } });
        await store.appendAgentFailure("failure", "stopped");
        await appendFile(path, '{"type":"partial"');
        const before = await readFile(path);
        const snapshot = await readSessionSnapshot(path);
        const expected: SessionExport = {
            format_version: 4,
            session: { id: snapshot.header.id, started_at: snapshot.header.timestamp, workspace: snapshot.header.cwd },
            transcript: projectTranscript(snapshot.messages, undefined, snapshot.messageStamps,
                snapshot.harnessMessages, snapshot.deliveredMessages).filter((entry) => entry.kind !== "reasoning"),
            agent_failure: { id: "failure", occurred_at: snapshot.agentFailure!.timestamp, detail: "stopped" },
        };
        expect(await exportSession(path, "json")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
        expect(await exportSession(path, "markdown")).toBe(renderSessionMarkdown(expected));
        expect(await readFile(path)).toEqual(before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("read-only indexed readers keep the scanned file if its path is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-export-replaced-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "session", cwd: root });
        const message = await store.appendMessage(user("original"));
        await store.appendHarnessMessage("original notice", "soft");
        const snapshot = await SessionStore.openReadOnly(path);
        try {
            await rename(path, `${path}.old`);
            const replacement = await SessionStore.create(path, { sessionId: "replacement", cwd: root });
            await replacement.appendMessage(user("different"));
            await expect(snapshot.appendName("no write")).rejects.toThrow("cannot write records");
            expect(await snapshot.readMessageEntry(message.id)).toEqual(message);
            const entries = [];
            for await (const entry of snapshot.walkMessageBranch(message.id)) entries.push(entry);
            expect(entries).toEqual([message]);
            const transcript = [];
            for await (const entry of walkSessionTranscript(snapshot, message.id, snapshot.appendedLineCount())) transcript.push(entry);
            expect(transcript.map((entry) => entry.kind)).toEqual(["user", "harness"]);
            expect(transcript.at(-1)).toMatchObject({ kind: "harness", text: "original notice" });
        } finally {
            await snapshot.closeReadOnly();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

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
        expect(markdown).not.toContain("private reasoning");
        expect(await readFile(path)).toEqual(before);
        const json = JSON.parse(await exportSession(path, "json"));
        expect(json.transcript[1].id).toEndWith("#0");
        expect(json).toEqual({
            format_version: 4,
            session: {
                id: "session-1",
                started_at: "2026-07-20T20:00:00.000Z",
                workspace: "/work/vera",
            },
            transcript: [
                {
                    id: expect.any(String),
                    recordedAt: expect.any(Number),
                    kind: "user",
                    text: "keep this prompt",
                },
                {
                    id: expect.any(String),
                    recordedAt: expect.any(Number),
                    kind: "assistant",
                    text: "Keep this reply.",
                },
            ],
        });
        expect(await readFile(path)).toEqual(before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Markdown export skips reasoning entries", () => {
    const exported = {
        format_version: 4 as const,
        session: { id: "crow", started_at: "2026-11-07T00:00:00Z", workspace: "/work" },
        transcript: [{ kind: "assistant" as const, text: "sail north" }],
    };
    expect(renderSessionMarkdown({
        ...exported,
        transcript: [
            { kind: "reasoning", text: "follow the stars" },
            ...exported.transcript,
        ],
    })).toBe(renderSessionMarkdown(exported));
});

test("JSON export keeps existing IDs and timing when reasoning follows the answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-reasoning-export-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, {
            sessionId: "crow",
            cwd: root,
            createId: () => "reply",
        });
        await store.appendMessage({
            role: "assistant",
            content: [
                { type: "thinking", text: "first summary" },
                { type: "text", text: "sail north" },
                { type: "thinking", text: "last summary" },
            ],
            source: { provider: "test", api: "test", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
            turnTiming: { durationMs: 500, finishedAt: 1_000 },
        });
        const json = JSON.parse(await exportSession(path, "json"));
        expect(json.transcript).toEqual([{
            kind: "assistant",
            id: "reply#0",
            recordedAt: expect.any(Number),
            text: "sail north",
            turnTiming: { durationMs: 500, finishedAt: 1_000 },
        }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Markdown export contains transcript content inside each speaker entry", () => {
    const markdown = renderSessionMarkdown({
        format_version: 4,
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
            {
                kind: "presentation",
                presentation: {
                    kind: "unified_diff",
                    path: "note.md",
                    patch: "--- note.md\n+++ note.md\n@@ -1 +1 @@\n-```\n+safe\n",
                },
            },
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
        "## Tool result\n\nFile: ` note.md `\n\n````diff\n",
    );
    expect(markdown).toContain("\n````\n\n## Vera");
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
            id: expect.any(String),
            recordedAt: expect.any(Number),
            kind: "error",
            outcome: "error",
            detail: "rate limited after retries",
        });
        expect(await exportSession(path, "markdown")).toContain(
            "## Model error\n\n> rate limited after retries",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("session export includes a resident lifecycle failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-agent-failure-export-"));
    const path = join(root, "session.jsonl");
    try {
        const store = await SessionStore.create(path, {
            sessionId: "failed-session",
            cwd: "/work/vera",
            now: () => new Date("2026-07-22T19:00:00.000Z"),
        });
        await store.appendAgentFailure(
            "failure-1",
            "Resident agent stopped unexpectedly",
        );

        const json = JSON.parse(await exportSession(path, "json"));
        expect(json.format_version).toBe(4);
        expect(json.agent_failure).toEqual({
            id: "failure-1",
            occurred_at: "2026-07-22T19:00:00.000Z",
            detail: "Resident agent stopped unexpectedly",
        });
        expect(await exportSession(path, "markdown")).toContain(
            "## Resident agent failure\n\n> Resident agent stopped unexpectedly",
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

test("Markdown export names the extension that added context", () => {
    const markdown = renderSessionMarkdown({
        format_version: 4,
        session: { id: "lookout", started_at: "2026-10-09T20:00:00.000Z", workspace: "/work/vera" },
        transcript: [
            { kind: "user", text: "where is the treasure?" },
            { kind: "hook_context", phase: "pre_turn", source: "lookout" },
        ],
    });

    expect(markdown).toContain("## Vera\n\n> lookout added context");
    expect(markdown).not.toContain("third palm");
});

test("Markdown export names the extension that continued the turn", () => {
    const markdown = renderSessionMarkdown({
        format_version: 4,
        session: { id: "lookout", started_at: "2026-10-09T20:00:00.000Z", workspace: "/work/vera" },
        transcript: [
            { kind: "user", text: "find the treasure" },
            { kind: "hook_context", phase: "turn_ending", source: "lookout" },
        ],
    });

    expect(markdown).toContain("> lookout continued the turn");
    expect(markdown).not.toContain("no map");
});

test("Markdown export shows a hook's display line with the extension name", () => {
    const markdown = renderSessionMarkdown({
        format_version: 4,
        session: { id: "lookout", started_at: "2026-10-09T20:00:00.000Z", workspace: "/work/vera" },
        transcript: [
            { kind: "user", text: "where is the treasure?" },
            {
                kind: "hook_context",
                phase: "pre_turn",
                source: "lookout",
                display: "Spotted: treasure under the third palm",
            },
        ],
    });

    expect(markdown).toContain("> Spotted: treasure under the third palm · lookout");
    expect(markdown).not.toContain("the crow buried it");
});
