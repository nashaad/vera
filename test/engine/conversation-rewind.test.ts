import { afterAll, expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewindConversationBefore } from "../../src/engine/conversation-rewind.ts";
import {
    createProtocolEncoder,
    projectTranscript,
    type AgentUpdate,
    type HistoryUpdate,
} from "../../src/engine/protocol.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import {
    withoutCallDuration,
    withoutSessionUsage,
} from "../support/wire-usage.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("conversation rewind publishes active history without changing files", async () => {
    const directory = temporaryDirectory();
    const sessionPath = join(directory, "session.jsonl");
    const workspaceFile = join(directory, "work.txt");
    writeFileSync(workspaceFile, "keep these exact bytes\n");
    const before = readFileSync(workspaceFile);
    const firstUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "first request" }],
    };
    const firstAssistant = assistantMessage("first answer");
    const secondUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "second request" }],
    };
    const secondAssistant = assistantMessage("second answer");
    const store = await SessionStore.create(sessionPath, {
        sessionId: "session-1",
        cwd: directory,
        createId: values(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
        ),
    });
    await store.appendMessage(firstUser);
    await store.appendMessage(firstAssistant);
    const secondBoundary = await store.appendMessage(secondUser);
    await store.appendMessage(secondAssistant);
    const state = {
        messages: [...store.messages()],
        store,
    };
    const updates: AgentUpdate[] = [];
    const protocol = createProtocolEncoder({
        send(update): void {
            updates.push(update);
        },
    });

    await rewindConversationBefore(state, protocol, secondBoundary.id);

    expect(state.messages).toEqual([firstUser, firstAssistant]);
    expect(updates.map(withoutSessionUsage)).toEqual([{
        type: "history",
        entries: projectTranscript(
            store.messages(),
            undefined,
            store.activeMessageIds(),
        ),
        seq: 0,
    }]);
    expect(
        (updates[0] as HistoryUpdate).entries.map((entry) => entry.id),
    ).toEqual(["message-1#0", "message-2#0"]);
    expect(readFileSync(workspaceFile)).toEqual(before);
    expect((await SessionStore.open(sessionPath)).messages()).toEqual([
        firstUser,
        firstAssistant,
    ]);
});

function assistantMessage(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-conversation-rewind-"));
    temporaryDirectories.push(directory);
    return directory;
}

function values<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) {
            throw new Error("No scripted value remains");
        }
        return item;
    };
}
