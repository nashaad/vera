import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { historyPageFromStore } from "../../src/host/history-page.ts";

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
