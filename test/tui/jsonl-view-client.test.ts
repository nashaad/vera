import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createJsonlViewClient,
    isJsonlViewClient,
} from "../../clients/tui/jsonl-view-client.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a jsonl view paints the stored transcript and does not start work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-jsonl-view-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: "/work/vera",
    });
    const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "hello from disk" }],
    };
    const assistant: ModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    await store.appendMessage(user);
    await store.appendMessage(assistant);

    const client = await createJsonlViewClient(path);
    expect(isJsonlViewClient(client)).toBe(true);
    expect(client.agentId).toBe("session-1");
    expect(client.workspace).toBe("/work/vera");
    expect(client.viewOnly).toBe(true);

    const history = await client.receive();
    expect(history).toMatchObject({
        type: "history",
        entries: [
            { kind: "user", text: "hello from disk" },
            { kind: "assistant", text: "hi" },
        ],
    });

    await expect(client.send({ type: "prompt", content: "again" }))
        .rejects.toThrow("on disk until it is opened for work");

    client.close();
});

test("a jsonl view activates on the first command that needs a loop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-jsonl-activate-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, {
        sessionId: "session-2",
        cwd: "/work/vera",
    });

    const sent: string[] = [];
    const client = await createJsonlViewClient(path, {
        onActivate: async (command) => {
            if (command.type === "prompt") sent.push(command.content);
        },
    });
    await client.send({ type: "prompt", content: "wake up" });
    expect(sent).toEqual(["wake up"]);
    client.close();
});
