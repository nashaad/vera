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
} from "../../src/store/session-store.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

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

test("session store ignores removed file checkpoint records", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const user: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "keep the conversation" }],
    };
    const assistant: ModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "kept" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-19T12:00:01.000Z",
            message: user,
        }),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-19T12:00:02.000Z",
            checkpointId: "removed-checkpoint",
            path: join(directory, "changed.txt"),
            existedBefore: true,
            tool: "edit",
            userMessageId: "message-1",
            beforeSha256: "a".repeat(64),
            afterSha256: "b".repeat(64),
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-19T12:00:03.000Z",
            message: assistant,
        }),
        "",
    ].join("\n"));

    const reopened = await SessionStore.open(path);

    expect(reopened.messages()).toEqual([user, assistant]);
    expect(reopened.entries()).toHaveLength(2);
});

test("session store rejects malformed removed checkpoint records", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "checkpoint",
            timestamp: "2026-07-19T12:00:01.000Z",
            checkpointId: "broken-checkpoint",
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 2 is not a valid removed checkpoint entry",
    );
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

test("conversation rewind keeps the physical tail and survives restart", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
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
    const replacementUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "replacement request" }],
    };
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-19T12:00:00.000Z",
            "2026-07-19T12:00:01.000Z",
            "2026-07-19T12:00:02.000Z",
            "2026-07-19T12:00:03.000Z",
            "2026-07-19T12:00:04.000Z",
            "2026-07-19T12:00:05.000Z",
            "2026-07-19T12:00:06.000Z",
        ),
        createId: values(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    await store.appendMessage(firstUser);
    await store.appendMessage(firstAssistant);
    const secondBoundary = await store.appendMessage(secondUser);
    await store.appendMessage(secondAssistant);

    const rewind = await store.rewindBefore(secondBoundary.id);

    expect(rewind).toEqual({
        type: "rewind",
        timestamp: "2026-07-19T12:00:05.000Z",
        userMessageId: "message-3",
        previousHeadId: "message-4",
        headId: "message-2",
    });
    expect(store.activeHeadId()).toBe("message-2");
    expect(store.activeEntries().map((entry) => entry.id)).toEqual([
        "message-1",
        "message-2",
    ]);
    expect(store.messages()).toEqual([firstUser, firstAssistant]);
    expect(store.entries()).toHaveLength(4);
    expect(readLines(path).map((line) => line.type)).toEqual([
        "session",
        "message",
        "message",
        "message",
        "message",
        "rewind",
    ]);
    await expect(store.rewindBefore(secondBoundary.id)).rejects.toThrow(
        "Rewind boundary message-3 is not an active user message",
    );

    const replacement = await store.appendMessage(replacementUser);

    expect(replacement.parentId).toBe("message-2");
    expect(store.messages()).toEqual([
        firstUser,
        firstAssistant,
        replacementUser,
    ]);

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-19T12:00:07.000Z"),
    });
    expect(reopened.header.id).toBe("session-1");
    expect(reopened.activeHeadId()).toBe("message-5");
    expect(reopened.messages()).toEqual([
        firstUser,
        firstAssistant,
        replacementUser,
    ]);
    expect(reopened.entries().map((entry) => entry.id)).toEqual([
        "message-1",
        "message-2",
        "message-3",
        "message-4",
        "message-5",
    ]);

    expect(await reopened.rewindBefore("message-1")).toEqual({
        type: "rewind",
        timestamp: "2026-07-19T12:00:07.000Z",
        userMessageId: "message-1",
        previousHeadId: "message-5",
        headId: null,
    });
    const rewoundAgain = await SessionStore.open(path);
    expect(rewoundAgain.activeHeadId()).toBeNull();
    expect(rewoundAgain.messages()).toEqual([]);
    expect(rewoundAgain.entries()).toHaveLength(5);
});

test("session store rejects a rewind record from an inactive head", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-19T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "first request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-19T12:00:02.000Z",
            message: assistantMessage("answer"),
        }),
        JSON.stringify({
            type: "rewind",
            timestamp: "2026-07-19T12:00:03.000Z",
            userMessageId: "message-1",
            previousHeadId: "message-1",
            headId: null,
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 4 rewinds from inactive head message-1",
    );
});

test("session store rejects a message that jumps onto an abandoned tail", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "session-1",
            timestamp: "2026-07-19T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-19T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "first request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-19T12:00:02.000Z",
            message: assistantMessage("answer"),
        }),
        JSON.stringify({
            type: "rewind",
            timestamp: "2026-07-19T12:00:03.000Z",
            userMessageId: "message-1",
            previousHeadId: "message-2",
            headId: null,
        }),
        JSON.stringify({
            type: "message",
            id: "message-3",
            parentId: "message-2",
            timestamp: "2026-07-19T12:00:04.000Z",
            message: assistantMessage("jumped back"),
        }),
        "",
    ].join("\n"));

    await expect(SessionStore.open(path)).rejects.toThrow(
        "line 5 does not extend the active head",
    );
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

test("command prefix grants survive reopening the durable session", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: dates(
            "2026-07-17T12:00:00.000Z",
            "2026-07-17T12:00:01.000Z",
        ),
    });

    await store.appendCommandPrefix({ tokens: ["git", "push", "origin"] });
    expect(store.commandPrefixes()).toEqual([
        { tokens: ["git", "push", "origin"] },
    ]);
    expect(readLines(path).at(-1)).toEqual({
        type: "command_prefix",
        timestamp: "2026-07-17T12:00:01.000Z",
        prefix: { tokens: ["git", "push", "origin"] },
    });

    const reopened = await SessionStore.open(path);
    expect(reopened.commandPrefixes()).toEqual([
        { tokens: ["git", "push", "origin"] },
    ]);
});

test("session store rejects malformed command prefix grants", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
    });

    await expect(store.appendCommandPrefix({ tokens: [] })).rejects.toThrow(
        "Cannot append an invalid command prefix",
    );
    expect(readLines(path)).toHaveLength(1);
});

test("pending deliveries are idempotent and survive restart until injected", async () => {
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
    appendFileSync(
        path,
        '{"type":"message","id":"torn","deliveryId":"delivery-1"',
    );

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-17T12:00:02.000Z"),
        createId: values("message-1"),
    });
    expect(reopened.pendingDeliveries()).toHaveLength(1);
    const notification: ModelMessage = {
        role: "user",
        internal: true,
        content: [{ type: "text", text: "background result" }],
    };
    await expect(reopened.appendDeliveryMessage(delivery.id, {
        role: "user",
        content: [{ type: "text", text: "not internal" }],
    })).rejects.toThrow("A delivery message must be an internal user message");
    expect(await reopened.appendDeliveryMessage(
        delivery.id,
        notification,
    )).toEqual({
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: "2026-07-17T12:00:02.000Z",
        deliveryId: "delivery-1",
        message: notification,
    });
    await expect(reopened.appendDeliveryMessage(
        delivery.id,
        notification,
    )).rejects.toThrow("Delivery delivery-1 is not pending");
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
        "message",
    ]);
});

test("rewind requeues only a delivery abandoned with its message", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const firstUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "first request" }],
    };
    const secondUser: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "second request" }],
    };
    const notification: ModelMessage = {
        role: "user",
        internal: true,
        content: [{ type: "text", text: "background result" }],
    };
    const delivery = {
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Background agent finished.",
    };
    const store = await SessionStore.create(path, {
        sessionId: "parent-1",
        cwd: directory,
        now: dates(
            "2026-07-19T12:00:00.000Z",
            "2026-07-19T12:00:01.000Z",
            "2026-07-19T12:00:02.000Z",
            "2026-07-19T12:00:03.000Z",
            "2026-07-19T12:00:04.000Z",
            "2026-07-19T12:00:05.000Z",
            "2026-07-19T12:00:06.000Z",
            "2026-07-19T12:00:07.000Z",
            "2026-07-19T12:00:08.000Z",
        ),
        createId: values(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    const firstBoundary = await store.appendMessage(firstUser);
    await store.appendMessage(assistantMessage("first answer"));
    await store.recordDelivery(delivery);
    await store.appendDeliveryMessage(delivery.id, notification);
    const secondBoundary = await store.appendMessage(secondUser);
    await store.appendMessage(assistantMessage("second answer"));

    expect(store.pendingDeliveries()).toEqual([]);
    await store.rewindBefore(secondBoundary.id);
    expect(store.pendingDeliveries()).toEqual([]);

    await store.rewindBefore(firstBoundary.id);
    const rewound = await SessionStore.open(path, {
        now: dates("2026-07-19T12:00:09.000Z"),
        createId: values("message-6"),
    });
    expect(rewound.pendingDeliveries()).toEqual([{
        type: "delivery",
        ...delivery,
        timestamp: "2026-07-19T12:00:03.000Z",
    }]);

    const reinjected = await rewound.appendDeliveryMessage(
        delivery.id,
        notification,
    );
    expect(reinjected.parentId).toBeNull();
    expect(reinjected.deliveryId).toBe(delivery.id);
    expect(rewound.pendingDeliveries()).toEqual([]);

    const reopened = await SessionStore.open(path);
    expect(reopened.pendingDeliveries()).toEqual([]);
    expect(reopened.activeEntries().map((entry) => entry.id)).toEqual([
        "message-6",
    ]);
    expect(reopened.entries()).toHaveLength(6);
});

test("session store still reads legacy delivery receipts", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "parent-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "delivery",
            id: "delivery-1",
            sourceAgentId: "background-1",
            content: "Finished.",
            timestamp: "2026-07-17T12:00:01.000Z",
        }),
        JSON.stringify({
            type: "delivery_receipt",
            deliveryId: "delivery-1",
            timestamp: "2026-07-17T12:00:02.000Z",
        }),
        "",
    ].join("\n"));

    expect((await SessionStore.open(path)).pendingDeliveries()).toEqual([]);
});

test("rewind requeues a legacy receipt linked by its record position", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const notification: ModelMessage = {
        role: "user",
        internal: true,
        content: [{ type: "text", text: "old background result" }],
    };
    writeFileSync(path, [
        JSON.stringify({
            type: "session",
            version: SESSION_FORMAT_VERSION,
            id: "parent-1",
            timestamp: "2026-07-17T12:00:00.000Z",
            cwd: directory,
        }),
        JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            timestamp: "2026-07-17T12:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "first request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-2",
            parentId: "message-1",
            timestamp: "2026-07-17T12:00:02.000Z",
            message: assistantMessage("first answer"),
        }),
        JSON.stringify({
            type: "delivery",
            id: "delivery-1",
            sourceAgentId: "background-1",
            content: "Finished.",
            timestamp: "2026-07-17T12:00:03.000Z",
        }),
        JSON.stringify({
            type: "message",
            id: "message-3",
            parentId: "message-2",
            timestamp: "2026-07-17T12:00:04.000Z",
            message: notification,
        }),
        JSON.stringify({
            type: "delivery_receipt",
            deliveryId: "delivery-1",
            timestamp: "2026-07-17T12:00:05.000Z",
        }),
        JSON.stringify({
            type: "message",
            id: "message-4",
            parentId: "message-3",
            timestamp: "2026-07-17T12:00:06.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "second request" }],
            },
        }),
        JSON.stringify({
            type: "message",
            id: "message-5",
            parentId: "message-4",
            timestamp: "2026-07-17T12:00:07.000Z",
            message: assistantMessage("second answer"),
        }),
        JSON.stringify({
            type: "rewind",
            timestamp: "2026-07-17T12:00:08.000Z",
            userMessageId: "message-1",
            previousHeadId: "message-5",
            headId: null,
        }),
        "",
    ].join("\n"));

    const reopened = await SessionStore.open(path, {
        now: dates("2026-07-17T12:00:09.000Z"),
        createId: values("message-6"),
    });
    expect(reopened.pendingDeliveries()).toHaveLength(1);
    await reopened.appendDeliveryMessage("delivery-1", notification);
    expect(reopened.pendingDeliveries()).toEqual([]);
    expect((await SessionStore.open(path)).pendingDeliveries()).toEqual([]);
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

test("session store rejects invalid delivery message links", async () => {
    const directory = temporaryDirectory();
    const header = {
        type: "session",
        version: SESSION_FORMAT_VERSION,
        id: "session-1",
        timestamp: "2026-07-17T12:00:00.000Z",
        cwd: directory,
    };
    const delivery = {
        type: "delivery",
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Finished.",
        timestamp: "2026-07-17T12:00:01.000Z",
    };
    const notification = {
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: "2026-07-17T12:00:02.000Z",
        deliveryId: "delivery-1",
        message: {
            role: "user",
            internal: true,
            content: [{ type: "text", text: "background result" }],
        },
    };
    const cases = [
        {
            name: "missing-delivery",
            records: [notification],
            error: "line 2 references missing delivery delivery-1",
        },
        {
            name: "non-internal",
            records: [
                delivery,
                {
                    ...notification,
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "not internal" }],
                    },
                },
            ],
            error: "line 3 has a non-internal delivery message",
        },
        {
            name: "active-duplicate",
            records: [
                delivery,
                notification,
                {
                    ...notification,
                    id: "message-2",
                    parentId: "message-1",
                    timestamp: "2026-07-17T12:00:03.000Z",
                },
            ],
            error: "line 4 repeats active delivery delivery-1",
        },
    ];

    for (const candidate of cases) {
        const path = join(directory, `${candidate.name}.jsonl`);
        writeFileSync(path, [
            JSON.stringify(header),
            ...candidate.records.map((record) => JSON.stringify(record)),
            "",
        ].join("\n"));
        await expect(SessionStore.open(path)).rejects.toThrow(candidate.error);
    }
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

function assistantMessage(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
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
