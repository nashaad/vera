import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    SessionStore,
    type OpenSessionAppendFile,
    type SessionAppendFile,
} from "../../src/store/session-store.ts";
import type { ModelMessage } from "../../src/model/types.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function texts(store: SessionStore): string[] {
    return store.messages().map((message) =>
        message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    );
}

interface Faults {
    // Writes this many bytes of the record to the real file, then throws.
    partialWriteBytes?: number;
    syncFailsAfterWrite?: boolean;
    truncateFails?: boolean;
    closeFails?: boolean;
    // Another writer appends this text to the real file, then our write fails.
    foreignTextBeforeFailure?: string;
}

// Wraps a real append handle so a fault hits the real file. Each call of the
// returned opener takes the next entry of plan; a missing entry means no fault.
function faultyOpener(plan: readonly (Faults | undefined)[]): OpenSessionAppendFile {
    let call = 0;
    return async (path) => {
        const faults = plan[call];
        call += 1;
        const real = await open(path, "a", 0o600);
        if (faults === undefined) return real;
        let written = false;
        const wrapped: SessionAppendFile = {
            stat: () => real.stat(),
            writeFile: async (data, encoding) => {
                if (faults.foreignTextBeforeFailure !== undefined) {
                    appendFileSync(path, faults.foreignTextBeforeFailure);
                    throw new Error("ENOSPC: no space left on device");
                }
                if (faults.partialWriteBytes !== undefined) {
                    const bytes = Buffer.from(data, encoding);
                    await real.writeFile(bytes.subarray(0, faults.partialWriteBytes));
                    throw new Error("ENOSPC: no space left on device");
                }
                await real.writeFile(data, encoding);
                written = true;
            },
            truncate: async (length) => {
                if (faults.truncateFails === true) throw new Error("EIO: truncate failed");
                await real.truncate(length);
            },
            sync: async () => {
                if (faults.syncFailsAfterWrite === true && written) {
                    written = false;
                    throw new Error("EIO: fsync failed");
                }
                await real.sync();
            },
            close: async () => {
                await real.close();
                if (faults.closeFails === true) throw new Error("EIO: close failed");
            },
        };
        return wrapped;
    };
}

async function createStore(plan: readonly (Faults | undefined)[]): Promise<{
    readonly path: string;
    readonly store: SessionStore;
}> {
    const directory = mkdtempSync(join(tmpdir(), "vera-append-failure-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    // The first open is the first append, which the plan leaves healthy unless it says otherwise.
    const store = await SessionStore.create(path, {
        sessionId: "append-failure",
        cwd: directory,
        openAppendFile: faultyOpener(plan),
    });
    return { path, store };
}

test("a write that fails halfway leaves the file as it was and the next append lands cleanly", async () => {
    const { path, store } = await createStore([undefined, { partialWriteBytes: 40 }]);
    const one = await store.appendMessage(user("one"));
    const before = readFileSync(path);

    await expect(store.appendMessage(user("two"))).rejects.toThrow("ENOSPC");
    expect(store.recordIndexStats().records).toBe(2);
    expect((await store.readIndexedMessage(one.id))?.message).toEqual(user("one"));

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(texts(store)).toEqual(["one"]);
    expect(store.appendedLineCount()).toBe(2);

    await store.appendMessage(user("three"));
    expect(texts(store)).toEqual(["one", "three"]);
    expect(texts(await SessionStore.open(path))).toEqual(["one", "three"]);
});

test("a sync that fails after a full write leaves the file as it was", async () => {
    const { path, store } = await createStore([undefined, { syncFailsAfterWrite: true }]);
    await store.appendMessage(user("one"));
    const before = readFileSync(path);

    await expect(store.appendMessage(user("two"))).rejects.toThrow("fsync failed");

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(texts(await SessionStore.open(path))).toEqual(texts(store));
    expect(store.appendedLineCount()).toBe(2);
});

test("a failed append does not disturb an append queued behind it", async () => {
    const { path, store } = await createStore([undefined, { syncFailsAfterWrite: true }]);
    await store.appendMessage(user("one"));

    const failed = store.appendMessage(user("two"));
    const behind = store.appendMessage(user("three"));

    await expect(failed).rejects.toThrow("fsync failed");
    await behind;
    expect(texts(store)).toEqual(["one", "three"]);
    expect(texts(await SessionStore.open(path))).toEqual(["one", "three"]);
    expect(store.appendedLineCount()).toBe(3);
});

test("a failed foreign append leaves the file and the projection as they were", async () => {
    const { path, store } = await createStore([{ syncFailsAfterWrite: true }]);
    const before = readFileSync(path);

    await expect(store.appendForeignRecord({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-10-30T12:00:00.000Z",
        message: user("foreign"),
    })).rejects.toThrow("fsync failed");

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(texts(store)).toEqual([]);
    expect(store.appendedLineCount()).toBe(1);
});

test("when the file cannot be restored the store refuses further appends until it is reopened", async () => {
    const { path, store } = await createStore([
        undefined,
        { syncFailsAfterWrite: true, truncateFails: true },
    ]);
    await store.appendMessage(user("one"));

    const error = await store.appendMessage(user("two")).then(
        () => undefined,
        (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("fsync failed");
    expect((error as Error).message).toContain("Reopen the session");
    expect(((error as Error).cause as Error).message).toBe("EIO: fsync failed");

    expect(texts(store)).toEqual(["one"]);
    await expect(store.appendMessage(user("three"))).rejects.toThrow("Reopen the session");
    await expect(store.appendForeignRecord({
        type: "session_name",
        timestamp: "2026-10-30T12:00:00.000Z",
        name: "late",
    })).rejects.toThrow("Reopen the session");
    expect(store.appendedLineCount()).toBe(2);

    // The reopened store replays the line the live one never applied, so both sides agree again.
    expect(texts(await SessionStore.open(path))).toEqual(["one", "two"]);
});

test("a close that fails after a durable write does not fail the append", async () => {
    const { path, store } = await createStore([undefined, { closeFails: true }]);
    await store.appendMessage(user("one"));

    await store.appendMessage(user("two"));

    expect(texts(store)).toEqual(["one", "two"]);
    expect(texts(await SessionStore.open(path))).toEqual(["one", "two"]);
    expect(store.appendedLineCount()).toBe(3);
});

test("an attachment recovered after an uncertain write remains indexed", async () => {
    const { path, store } = await createStore([{ syncFailsAfterWrite: true, truncateFails: true }]);
    const sha256 = "a".repeat(64);
    const attachment = {
        id: `${sha256}.png`, name: "map.png", mediaType: "image/png" as const,
        bytes: 10, width: 2, height: 2, sha256,
    };

    expect(await store.appendAttachment(attachment)).toEqual(attachment);
    expect(await store.appendAttachment(attachment)).toEqual(attachment);
    expect(store.attachmentRecords()).toEqual([attachment]);
    expect(store.recordIndexStats().records).toBe(2);
    expect((await SessionStore.open(path)).attachmentRecords()).toEqual([attachment]);
});

test("a rollback never cuts bytes another writer appended after ours", async () => {
    const foreignLine = JSON.stringify({
        type: "session_name",
        timestamp: "2026-10-30T12:00:00.000Z",
        name: "renamed by another writer ".repeat(30),
    }) + "\n";
    const { path, store } = await createStore([undefined, { foreignTextBeforeFailure: foreignLine }]);
    await store.appendMessage(user("one"));
    const before = readFileSync(path);

    await expect(store.appendMessage(user("two"))).rejects.toThrow("ENOSPC");

    // The foreign line is the only change, so nothing of it was truncated.
    expect(readFileSync(path).equals(Buffer.concat([before, Buffer.from(foreignLine)]))).toBe(true);
    await expect(store.appendMessage(user("three"))).rejects.toThrow("Reopen the session");
    expect(store.appendedLineCount()).toBe(2);
});
