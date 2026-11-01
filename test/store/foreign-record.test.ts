import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/store/session-store.ts";
import type { ModelMessage } from "../../src/model/types.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function messageRecord(
    id: string,
    parentId: string | null,
    text: string,
): Record<string, unknown> {
    const message: ModelMessage = {
        role: "user",
        content: [{ type: "text", text }],
    };
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-10-30T12:00:00.000Z",
        message,
    };
}

async function openStoreWithOneMessage(): Promise<{
    readonly path: string;
    readonly store: SessionStore;
}> {
    const directory = mkdtempSync(join(tmpdir(), "vera-foreign-record-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: "/work/vera",
    });
    expect(await store.appendForeignRecord(messageRecord("m1", null, "one")))
        .toBe(2);
    return { path, store };
}

const rejectedRecords: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["an unknown record type", { type: "nonsense" }],
    [
        "a message that does not extend the active head",
        messageRecord("m2", "elsewhere", "two"),
    ],
    ["a message that repeats an entry id", messageRecord("m1", "m1", "again")],
    [
        "a name with no text",
        { type: "session_name", timestamp: "2026-10-30T12:00:00.000Z" },
    ],
];

for (const [label, record] of rejectedRecords) {
    test(`a rejected foreign record leaves the file and the store untouched: ${label}`, async () => {
        const { path, store } = await openStoreWithOneMessage();
        const before = readFileSync(path, "utf8");
        const linesBefore = store.appendedLineCount();

        await expect(store.appendForeignRecord(record)).rejects.toThrow(
            /not a valid|repeats|does not extend|invalid/i,
        );

        expect(readFileSync(path, "utf8")).toBe(before);
        expect(store.appendedLineCount()).toBe(linesBefore);
        expect(store.messages().map((message) => message.content)).toEqual([
            [{ type: "text", text: "one" }],
        ]);

        const reopened = await SessionStore.open(path);
        expect(reopened.messages().length).toBe(1);

        expect(
            await store.appendForeignRecord(messageRecord("m2", "m1", "two")),
        ).toBe(3);
        expect(store.messages().length).toBe(2);
        expect((await SessionStore.open(path)).messages().length).toBe(2);
    });
}

test("a foreign record that passes is durable and visible before the call resolves", async () => {
    const { path, store } = await openStoreWithOneMessage();

    expect(await store.appendForeignRecord({
        type: "session_name",
        timestamp: "2026-10-30T12:00:00.000Z",
        name: "named by the worker",
    })).toBe(3);

    expect(store.name()).toBe("named by the worker");
    expect((await SessionStore.open(path)).name()).toBe("named by the worker");
});

test("a rejected foreign record does not hold up the appends queued behind it", async () => {
    const { path, store } = await openStoreWithOneMessage();

    const results = await Promise.allSettled([
        store.appendForeignRecord({ type: "nonsense" }),
        store.appendForeignRecord(messageRecord("m2", "m1", "two")),
        store.appendForeignRecord({ type: "nonsense" }),
        store.appendForeignRecord(messageRecord("m3", "m2", "three")),
    ]);

    expect(results.map((result) => result.status)).toEqual([
        "rejected",
        "fulfilled",
        "rejected",
        "fulfilled",
    ]);
    expect(store.appendedLineCount()).toBe(4);
    expect((await SessionStore.open(path)).messages().length).toBe(3);
});
