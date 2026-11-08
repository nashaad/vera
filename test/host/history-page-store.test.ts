import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { projectTranscript } from "../../src/engine/protocol.ts";
import { historyPageFromEntries, historyPageFromStore } from "../../src/host/history-page.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-history-page-"));
    temporaryDirectories.push(directory);
    return directory;
}

function userMessage(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function scripted<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) throw new Error("No scripted value remains");
        return item;
    };
}

test("a rewound cursor pages its own chain and reports the active head", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: () => new Date("2026-11-04T12:00:00.000Z"),
        createId: scripted(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    await store.appendMessage(userMessage("one"));
    await store.appendMessage(assistantMessage("two"));
    await store.appendMessage(userMessage("three"));
    await store.appendMessage(assistantMessage("four"));
    await store.rewindBefore("message-3");
    await store.appendMessage(userMessage("replacement"));

    expect(store.activeHeadId()).toBe("message-5");
    expect(store.pageSourceTo("message-4")?.messages.map((message) =>
        message.content[0]?.type === "text" ? message.content[0].text : ""
    )).toEqual(["one", "two", "three", "four"]);
    expect(store.pageSourceTo("message-4")?.headId).toBe("message-5");
    expect(store.pageSourceTo("message-5")?.messages).toHaveLength(3);
    expect(store.pageSourceTo("missing")).toBeUndefined();

    const page = historyPageFromStore(store, "message-3#0");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.entries.map((entry) => entry.id)).toEqual([
        "message-1#0",
        "message-2#0",
    ]);
    expect(page.page).toEqual({
        pageVersion: 1,
        hasMore: false,
        headId: "message-5",
        tailId: "message-2#0",
    });

    expect(historyPageFromStore(store, "missing#0")).toEqual({
        kind: "cursor_not_found",
    });
});

test("a reopened store returns reasoning in its host history page", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "reasoning.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "reasoning-session",
        cwd: directory,
        createId: scripted("user-one", "reply-one", "user-two"),
    });
    await store.appendMessage(userMessage("find the island"));
    await store.appendMessage({
        role: "assistant",
        content: [
            { type: "thinking", text: "follow the stars", signature: "opaque" },
            { type: "text", text: "sail north" },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    await store.appendMessage(userMessage("continue"));
    const reopened = await SessionStore.open(path);
    const page = historyPageFromStore(reopened, "user-two#0");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.entries.map(({ kind }) => kind)).toEqual(["user", "reasoning", "assistant"]);
    expect(page.entries[1]).toMatchObject({ kind: "reasoning", id: "reply-one#r0", text: "follow the stars" });
    expect(page.entries[2]).toMatchObject({ kind: "assistant", id: "reply-one#0", text: "sail north" });
    expect(JSON.stringify(page)).not.toContain("opaque");
});

test("a reopened store pages through a split turn without dropping its prefix", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "long-turn.jsonl");
    let nextId = 0;
    const store = await SessionStore.create(path, {
        sessionId: "long-turn",
        cwd: directory,
        createId: () => `message-${nextId++}`,
    });
    await store.appendMessage(userMessage("find the island"));
    for (let index = 0; index < 125; index += 1) {
        await store.appendMessage({
            role: "assistant",
            content: [{ type: "tool_call", id: `call-${index}`, name: "read", input: {} }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendMessage({
            role: "tool_result",
            toolCallId: `call-${index}`,
            toolName: "read",
            content: [{ type: "text", text: "charted" }],
            isError: false,
        });
    }
    const reopened = await SessionStore.open(path);
    const entries = projectTranscript(reopened.messages(), undefined, reopened.activeMessageStamps());
    let page = historyPageFromEntries(entries);
    if (page.kind !== "page") throw new Error("expected a tail page");
    const pages = [page.entries];
    while (page.page.hasMore) {
        const before = page.page.olderBefore;
        if (before === undefined) throw new Error("missing page cursor");
        page = historyPageFromStore(reopened, before);
        if (page.kind !== "page") throw new Error(`expected a page, got ${page.kind}`);
        pages.unshift(page.entries);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat().map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
}, 30_000);
