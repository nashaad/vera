import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectTranscript } from "../../src/engine/protocol.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("one message numbers every entry it projects to", async () => {
    const { store } = await storeWith([
        userMessage("run the tool"),
        {
            role: "assistant",
            content: [
                { type: "text", text: "Running it now." },
                {
                    type: "tool_call",
                    id: "call-1",
                    name: "read",
                    input: { path: "a.txt" },
                },
            ],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ]);

    expect(identities(store)).toEqual([
        ["message-1#0", "user"],
        ["message-2#0", "assistant"],
        ["message-2#1", "tool"],
    ]);
});

test("a tool result and its presentation share the message and differ by index", async () => {
    const { store } = await storeWith([
        userMessage("edit the file"),
        {
            role: "tool_result",
            toolCallId: "call-1",
            toolName: "edit",
            content: [{ type: "text", text: "applied" }],
            isError: false,
            presentation: {
                kind: "unified_diff",
                path: "a.txt",
                patch: "@@\n-one\n+two\n",
            },
        },
    ]);

    expect(identities(store)).toEqual([
        ["message-1#0", "user"],
        ["message-2#0", "tool_result"],
        ["message-2#1", "presentation"],
    ]);
});

test("entry IDs survive a restart", async () => {
    const { store, path } = await storeWith([
        userMessage("first request"),
        assistantMessage("first answer"),
    ]);
    const before = identities(store);

    expect(identities(await SessionStore.open(path))).toEqual(before);
});

test("compaction leaves transcript IDs alone", async () => {
    const { store } = await storeWith([
        userMessage("first request"),
        assistantMessage("first answer"),
        userMessage("second request"),
        assistantMessage("second answer"),
    ]);
    const before = identities(store);

    // Compaction rewrites what the model is sent, which is a different channel
    // from the transcript clients render.
    await store.appendCompaction({
        boundaryMessageId: "message-2",
        firstRetainedMessageId: "message-3",
        projection: [assistantMessage("summary of the first exchange")],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    });

    expect(identities(store)).toEqual(before);
});

test("a rewind keeps the IDs of the messages it leaves standing", async () => {
    const { store } = await storeWith([
        userMessage("first request"),
        assistantMessage("first answer"),
        userMessage("second request"),
        assistantMessage("second answer"),
    ]);
    const survivors = identities(store).slice(0, 2);

    await store.rewindBefore("message-3");

    expect(identities(store)).toEqual(survivors);
});

function identities(store: SessionStore): [string | undefined, string][] {
    return projectTranscript(
        store.messages(),
        undefined,
        store.activeMessageIds(),
    ).map((entry) => [entry.id, entry.kind]);
}

async function storeWith(
    messages: readonly ModelMessage[],
): Promise<{ store: SessionStore; path: string }> {
    const directory = mkdtempSync(join(tmpdir(), "vera-transcript-identity-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    let next = 1;
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        createId: () => `message-${next++}`,
    });
    for (const message of messages) {
        await store.appendMessage(message);
    }
    return { store, path };
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
