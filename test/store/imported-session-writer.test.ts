import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeImportedSession } from "../../src/store/imported-session-writer.ts";
import { SessionStore, readSessionSnapshot } from "../../src/store/session-store.ts";

const provenance = {
    tool: "claude-code",
    sourceSessionId: "cc-session",
    sourcePath: "/work/cc-session.jsonl",
    sourceSha256: "a".repeat(64),
    sourceStartedAt: "2026-09-01T10:00:00.000Z",
    importedAt: "2026-09-17T12:00:00.000Z",
} as const;

function exchange() {
    return [
        {
            message: { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
            timestamp: "2026-09-01T10:00:00.000Z",
        },
        {
            message: {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "hello" }],
                source: { provider: "claude-code", api: "none", model: "claude-code" },
                usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 0,
                },
                stopReason: "stop" as const,
            },
            timestamp: "2026-09-01T10:00:05.000Z",
        },
    ];
}

test("an imported session records where it came from and chains its messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-import-writer-"));
    try {
        const path = join(root, "sessions", "imported.jsonl");
        let next = 0;
        await writeImportedSession(path, {
            sessionId: "imported",
            cwd: "/work",
            provenance,
            messages: exchange(),
            name: "Fix the build",
            createId: () => `m${++next}`,
        });
        const snapshot = await readSessionSnapshot(path);
        expect(snapshot.header.importedFrom).toEqual({
            ...provenance,
            messageCount: 2,
            lastMessageId: "m2",
        });
        expect(snapshot.header.cwd).toBe("/work");
        expect([...snapshot.messageIds.values()]).toEqual(["m1", "m2"]);
        expect(snapshot.messages.map((message) => message.role))
            .toEqual(["user", "assistant"]);
        expect((await SessionStore.open(path)).name()).toBe("Fix the build");
        expect(await readdir(join(root, "sessions"))).toEqual(["imported.jsonl"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an import never replaces a session already at its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-import-writer-"));
    try {
        const path = join(root, "taken.jsonl");
        await writeFile(path, "keep\n");
        await expect(writeImportedSession(path, {
            sessionId: "taken",
            cwd: "/work",
            provenance,
            messages: exchange(),
        })).rejects.toThrow();
        expect(await Bun.file(path).text()).toBe("keep\n");
        expect(await readdir(root)).toEqual(["taken.jsonl"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a header with broken import facts does not open", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-import-writer-"));
    try {
        const path = join(root, "bad.jsonl");
        await writeImportedSession(path, {
            sessionId: "bad",
            cwd: "/work",
            provenance,
            messages: exchange(),
        });
        const lines = (await Bun.file(path).text()).split("\n");
        const header = JSON.parse(lines[0]!);
        header.importedFrom.sourceSha256 = "not-a-hash";
        lines[0] = JSON.stringify(header);
        await writeFile(path, lines.join("\n"));
        await expect(SessionStore.open(path)).rejects.toThrow();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
