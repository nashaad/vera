import { afterAll, expect, test } from "bun:test";
import {
    appendFileSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    SESSION_FORMAT_VERSION,
    SessionStore,
    type SessionCheckpointEntry,
} from "../../src/store/session-store.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { sha256Text } from "../../src/store/checkpoint-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("session store creates a header and reloads one message chain", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions", "session.jsonl");
    const times = dates(
        "2026-07-17T12:00:00.000Z",
        "2026-07-17T12:00:01.000Z",
        "2026-07-17T12:00:02.000Z",
        "2026-07-17T12:00:03.000Z",
    );
    const ids = values("message-1", "message-2", "message-3");
    const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "hello" }],
    };
    const assistant: ModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const toolResult: ModelMessage = {
        role: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
    };

    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: "/work/vera",
        now: times,
        createId: ids,
    });
    await store.appendMessage(user);
    await store.appendMessage(assistant);
    await store.appendMessage(toolResult);

    expect(readLines(path)).toEqual([
        {
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: "/work/vera",
        },
        {
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-17T12:00:01.000Z",
            message: user,
        },
        {
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-17T12:00:02.000Z",
            message: assistant,
        },
        {
            type: "message",
            id: "message-3",
            parentId: "message-2",
            timestamp: "2026-07-17T12:00:03.000Z",
            message: toolResult,
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.header.id).toBe("session-1");
    expect(reopened.messages()).toEqual([user, assistant, toolResult]);
});

test("session store serializes concurrent appends into one chain", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
            "2026-07-17T12:00:02.000Z",
        ),
        createId: values("message-1", "message-2"),
    });
    const first: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "first" }],
    };
    const second: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "second" }],
    };

    await Promise.all([
        store.appendMessage(first),
        store.appendMessage(second),
    ]);

    expect(store.entries().map((entry) => entry.parentId)).toEqual([
        null,
        "message-1",
    ]);
    expect((await SessionStore.open(path)).messages()).toEqual([first, second]);
});

test("model settings records restore the latest complete selection", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
            "2026-07-17T12:00:02.000Z",
        ),
    });

    await store.appendModelSettings({
        model: "first-model",
        reasoningEffort: "high",
    });
    await store.appendModelSettings({ model: "second-model" });

    expect(store.modelSettings()).toEqual({ model: "second-model" });
    expect(readLines(path).slice(1)).toEqual([
        {
            type: "model_settings",
            timestamp: "2026-07-17T12:00:01.000Z",
            settings: {
                model: "first-model",
                reasoningEffort: "high",
            },
        },
        {
            type: "model_settings",
            timestamp: "2026-07-17T12:00:02.000Z",
            settings: { model: "second-model" },
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.modelSettings()).toEqual({ model: "second-model" });
    expect(reopened.messages()).toEqual([]);
});

test("session store rejects invalid model settings before writing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendModelSettings({ model: "" })).rejects.toThrow(
        "Cannot append invalid model settings",
    );
    await expect(store.appendModelSettings({
        model: "test",
        reasoningEffort: "turbo",
    } as unknown as ModelTurnSettings)).rejects.toThrow(
        "Cannot append invalid model settings",
    );
    expect(readLines(path)).toHaveLength(1);
});

test("permission records restore the latest mode outside message history", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
            "2026-07-17T12:00:02.000Z",
        ),
    });

    await store.appendApprovalMode("ask");
    await store.appendApprovalMode("full_access");

    expect(store.approvalMode()).toBe("full_access");
    expect(readLines(path).slice(1)).toEqual([
        {
            type: "permissions",
            timestamp: "2026-07-17T12:00:01.000Z",
            mode: "ask",
        },
        {
            type: "permissions",
            timestamp: "2026-07-17T12:00:02.000Z",
            mode: "full_access",
        },
    ]);

    const reopened = await SessionStore.open(path);
    expect(reopened.approvalMode()).toBe("full_access");
    expect(reopened.messages()).toEqual([]);
});

test("session store rejects invalid permissions before writing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendApprovalMode(
        "always_allow" as "full_access",
    )).rejects.toThrow("Cannot append invalid permissions mode");
    expect(readLines(path)).toHaveLength(1);
});

test("checkpoint records list in order and survive restart", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
            "2026-07-17T12:00:02.000Z",
            "2026-07-17T12:00:03.000Z",
        ),
        createId: values("user-message-1"),
    });

    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "change the files" }],
    });

    await store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "note.txt"),
        existedBefore: true,
        tool: "edit",
        userMessageId: "user-message-1",
        beforeSha256: sha256Text("old note"),
        afterSha256: sha256Text("new note"),
    });
    await store.appendCheckpoint({
        checkpointId: "checkpoint-2",
        path: join(directory, "new.txt"),
        existedBefore: false,
        tool: "write",
        userMessageId: "user-message-1",
        beforeSha256: null,
        afterSha256: sha256Text("new file"),
    });

    const expected: SessionCheckpointEntry[] = [
        {
            type: "checkpoint",
            timestamp: "2026-07-17T12:00:02.000Z",
            checkpointId: "checkpoint-1",
            path: join(directory, "note.txt"),
            existedBefore: true,
            tool: "edit",
            userMessageId: "user-message-1",
            beforeSha256: sha256Text("old note"),
            afterSha256: sha256Text("new note"),
        },
        {
            type: "checkpoint",
            timestamp: "2026-07-17T12:00:03.000Z",
            checkpointId: "checkpoint-2",
            path: join(directory, "new.txt"),
            existedBefore: false,
            tool: "write",
            userMessageId: "user-message-1",
            beforeSha256: null,
            afterSha256: sha256Text("new file"),
        },
    ];
    expect(store.checkpoints()).toEqual(expected);
    expect(readLines(path).slice(2)).toEqual(
        expected as unknown as Array<Record<string, unknown>>,
    );

    const reopened = await SessionStore.open(path);
    expect(reopened.checkpoints()).toEqual(expected);
    expect(reopened.messages()).toEqual([{
        role: "user",
        content: [{ type: "text", text: "change the files" }],
    }]);
});

test("session store rejects a duplicate checkpoint id before writing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        createId: values("user-message-1"),
    });

    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "change the file" }],
    });

    await store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "note.txt"),
        existedBefore: true,
        tool: "edit",
        userMessageId: "user-message-1",
        beforeSha256: sha256Text("before"),
        afterSha256: sha256Text("after"),
    });
    await expect(store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "other.txt"),
        existedBefore: true,
        tool: "write",
        userMessageId: "user-message-1",
        beforeSha256: sha256Text("before"),
        afterSha256: sha256Text("after"),
    })).rejects.toThrow("Checkpoint checkpoint-1 already exists");
    expect(readLines(path)).toHaveLength(3);
});

test("session store keeps legacy checkpoints readable but unverifiable", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-17T12:00:01.000Z",
            checkpointId: "legacy-checkpoint",
            path: join(directory, "note.txt"),
            existedBefore: true,
            tool: "edit",
        }),
        "",
    ].join("\n"));

    expect((await SessionStore.open(path)).checkpoints()).toEqual([{
        type: "checkpoint",
        timestamp: "2026-07-17T12:00:01.000Z",
        checkpointId: "legacy-checkpoint",
        path: join(directory, "note.txt"),
        existedBefore: true,
        tool: "edit",
    }]);
});

test("session store rejects a checkpoint without the latest user boundary", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "note.txt"),
        existedBefore: true,
        tool: "edit",
        userMessageId: "missing-user-message",
        beforeSha256: sha256Text("before"),
        afterSha256: sha256Text("after"),
    })).rejects.toThrow("does not reference the latest user message");
    expect(readLines(path)).toHaveLength(1);
});

test("session store rejects a stale user boundary", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        createId: values("user-message-1", "user-message-2"),
    });

    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "first turn" }],
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "second turn" }],
    });

    await expect(store.appendCheckpoint({
        checkpointId: "checkpoint-1",
        path: join(directory, "note.txt"),
        existedBefore: true,
        tool: "edit",
        userMessageId: "user-message-1",
        beforeSha256: sha256Text("before"),
        afterSha256: sha256Text("after"),
    })).rejects.toThrow("does not reference the latest user message");
    expect(readLines(path)).toHaveLength(3);
});

test("session store rejects partial checkpoint boundary metadata", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-17T12:00:01.000Z",
            checkpointId: "broken-checkpoint",
            path: join(directory, "note.txt"),
            existedBefore: true,
            tool: "edit",
            userMessageId: "user-message-1",
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 is not a valid checkpoint entry",
    );
});

test("pending deliveries are idempotent and survive restart until acknowledged", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const delivery = {
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Background agent finished: tests pass.",
    };
    const store = await SessionStore.create(path, {
        sessionId: "parent-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
        ),
    });

    expect(await Promise.all([
        store.recordDelivery(delivery),
        store.recordDelivery(delivery),
    ])).toEqual([true, false]);
    expect(store.pendingDeliveries()).toEqual([{
        type: "delivery",
        ...delivery,
        timestamp: "2026-07-17T12:00:01.000Z",
    }]);

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-17T12:00:02.000Z"),
    });
    expect(reopened.pendingDeliveries()).toHaveLength(1);
    expect(await reopened.acknowledgeDelivery(delivery.id)).toBe(true);
    expect(await reopened.acknowledgeDelivery(delivery.id)).toBe(false);
    expect(await reopened.recordDelivery(delivery)).toBe(false);
    await expect(reopened.recordDelivery({
        ...delivery,
        content: "Conflicting result",
    })).rejects.toThrow(
        "Delivery delivery-1 conflicts with its stored payload",
    );
    expect(reopened.pendingDeliveries()).toEqual([]);

    const afterSecondRestart = await SessionStore.open(path);
    expect(afterSecondRestart.pendingDeliveries()).toEqual([]);
    expect(readLines(path).map((line) => line.type)).toEqual([
        "session",
        "delivery",
        "delivery_receipt",
    ]);
});

test("session store removes one unterminated crash fragment before appending", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "kept" }],
    };
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates("2026-07-17T12:00:00.000Z", "2026-07-17T12:00:01.000Z"),
        createId: values("message-1"),
    });
    await store.appendMessage(user);
    appendFileSync(path, '{"type":"message","id":"torn');

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-17T12:00:02.000Z"),
        createId: values("message-2"),
    });
    expect(reopened.messages()).toEqual([user]);
    await reopened.appendMessage({
        role: "user",
        content: [{ type: "text", text: "after restart" }],
    });

    expect(readLines(path).map((line) => line.type)).toEqual([
        "session",
        "message",
        "message",
    ]);
    expect(readFileSync(path, "utf8")).not.toContain('"id":"torn');
});

test("session store rejects malformed complete entries", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: "missing",
            timestamp: "2026-07-17T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "hello" }],
            },
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 references missing parent missing",
    );
});

test("session store rejects messages that only resemble engine types", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-17T12:00:01.000Z",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
                source: {},
                usage: {},
                stopReason: "invented",
            },
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 is not a valid message entry",
    );
});

test("session store rejects an invalid message before writing", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });
    const invalid = {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        source: {},
        usage: {},
        stopReason: "invented",
    } as unknown as ModelMessage;

    await expect(store.appendMessage(invalid)).rejects.toThrow(
        "Cannot append an invalid model message",
    );
    expect(readLines(path)).toHaveLength(1);
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-store-"));
    temporaryDirectories.push(directory);
    return directory;
}

function readLines(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dates(...timestamps: string[]): () => Date {
    const next = values(...timestamps);
    return () => new Date(next());
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
