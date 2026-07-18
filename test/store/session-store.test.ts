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
