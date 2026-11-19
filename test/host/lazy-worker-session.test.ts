import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerSessionStore } from "../../src/host/worker/session.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];
afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

async function createSession(): Promise<{ path: string; header: Record<string, unknown> }> {
    const directory = mkdtempSync(join(tmpdir(), "vera-lazy-worker-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "lazy-worker", cwd: directory });
    return { path, header: { ...store.header } };
}

async function records(store: WorkerSessionStore): Promise<readonly Record<string, unknown>[]> {
    const found: Record<string, unknown>[] = [];
    for await (const item of store.walkRecords()) found.push(item.record);
    return found;
}

test("pending worker reads include the virtual header without setup records", async () => {
    const { path, header } = await createSession();
    rmSync(path);
    const store = WorkerSessionStore.seed(path, header);
    store.applyCommittedLines(1);

    expect(await records(store)).toEqual([header]);
});

test("pending worker reads replay setup records and switch to file after setup publication", async () => {
    const { path, header } = await createSession();
    rmSync(path);
    const store = WorkerSessionStore.seed(path, header);
    store.applyCommittedLines(1);
    const identity = {
        type: "session_identity",
        timestamp: new Date().toISOString(),
        name: "Captain",
        key: "captain",
    };
    store.applyHostRecord(2, identity);
    expect(await records(store)).toEqual([header, identity]);

    const settings = {
        type: "model_settings",
        timestamp: new Date().toISOString(),
        settings: { model: "test/model" },
    };
    writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(identity)}\n${JSON.stringify(settings)}\n`);
    store.applyHostRecord(3, settings);

    expect(await records(store)).toEqual([header, identity, settings]);
});

test("the first message remains readable when it publishes the session file", async () => {
    const { path, header } = await createSession();
    rmSync(path);
    const store = WorkerSessionStore.seed(path, header);
    store.applyCommittedLines(1);
    const identity = {
        type: "session_identity",
        timestamp: new Date().toISOString(),
        name: "Captain",
        key: "captain",
    };
    store.applyHostRecord(2, identity);
    const message = {
        type: "turn_start",
        id: "first-message",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
    };
    writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(identity)}\n${JSON.stringify(message)}\n`);
    store.applyHostRecord(3, message);

    expect(await records(store)).toEqual([header, identity, message]);
});

test("an acknowledged worker setup append remains in the pending overlay", async () => {
    const { path, header } = await createSession();
    rmSync(path);
    const store = WorkerSessionStore.seed(path, header);
    store.applyCommittedLines(1);
    store.setAppender(async () => 2);

    await store.appendIdentity({ name: "Captain", key: "captain" });

    expect(await records(store)).toEqual([
        header,
        expect.objectContaining({ type: "session_identity", name: "Captain", key: "captain" }),
    ]);
});

test("eager setup records do not create a virtual prefix", async () => {
    const { path, header } = await createSession();
    const identity = {
        type: "session_identity",
        timestamp: new Date().toISOString(),
        name: "Captain",
        key: "captain",
    };
    writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(identity)}\n`);
    const store = WorkerSessionStore.seed(path, header);
    store.applyCommittedLines(2);

    expect(await records(store)).toEqual([header, identity]);
});
