import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { sessionSeedFromStore } from "../../src/host/worker/handle.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { parseHeaderRecord, SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];
afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-seed-"));
    directories.push(directory);
    return directory;
}

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function answer(text: string): ModelMessage {
    return { role: "assistant", content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop" };
}

async function expectMatchesBytePass(store: SessionStore): Promise<void> {
    const old = await readSessionSeed(store.path);
    const seed = sessionSeedFromStore(store);
    expect(seed.path).toBe(old.path);
    expect(seed.lineCount).toBe(old.lineCount);
    expect(parseHeaderRecord(seed.path, seed.header)).toEqual(parseHeaderRecord(old.path, old.header));
}

test("@core worker seed comes from the store and matches its committed count", async () => {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "seed", cwd: directory });
    await store.appendMessage(user("map"));
    const old = await readSessionSeed(path);
    renameSync(path, `${path}.moved`);
    const seed = await store.exclusively(async () => sessionSeedFromStore(store));
    expect(seed.lineCount).toBe(old.lineCount);
    expect(seed).toEqual(old);
});

test("store seeds match plain, CRLF and partial session files", async () => {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    const created = await SessionStore.create(path, { sessionId: "seed", cwd: directory });
    await created.appendMessage(user("map"));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    header.startupProfile = "bare";
    header.extra = { retained: true };
    lines[0] = JSON.stringify(header);
    writeFileSync(path, `${lines.join("\n")}\n`);
    const plain = await SessionStore.open(path);
    await expectMatchesBytePass(plain);
    expect(plain.header).toMatchObject({ contextAssemblyMode: "bare", extra: { retained: true } });
    expect("startupProfile" in plain.header).toBe(false);

    writeFileSync(path, `${lines.join("\r\n")}\r\n`);
    await expectMatchesBytePass(await SessionStore.open(path));
    appendFileSync(path, '{"type":"message"');
    const readonly = await SessionStore.openReadOnly(path);
    try {
        await expectMatchesBytePass(readonly);
    } finally {
        await readonly.closeReadOnly();
    }
    const repaired = await SessionStore.open(path);
    await expectMatchesBytePass(repaired);
    expect(readFileSync(path, "utf8").endsWith("\r\n")).toBe(true);
});

test("an empty line prevents a session from opening", async () => {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    await SessionStore.create(path, { sessionId: "seed", cwd: directory });
    appendFileSync(path, "\n");
    await expect(SessionStore.open(path)).rejects.toThrow();
    await expect(SessionStore.openReadOnly(path)).rejects.toThrow();
});

test("store seeds match after foreign messages, compaction and rewind", async () => {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "seed", cwd: directory });
    const timestamp = new Date().toISOString();
    await store.appendForeignRecord({ type: "turn_start", id: "first", parentId: null, timestamp, message: user("first") });
    await store.appendForeignRecord({ type: "message", id: "answer", parentId: "first", timestamp, message: answer("answer") });
    await store.appendForeignRecord({ type: "turn_start", id: "second", parentId: "answer", timestamp, message: user("second") });
    await store.appendForeignRecord({ type: "message", id: "last", parentId: "second", timestamp, message: answer("last") });
    await expectMatchesBytePass(store);
    await store.appendForeignRecord({ type: "compaction", id: "compact", timestamp,
        boundaryMessageId: "answer", firstRetainedMessageId: "second",
        projection: [answer("summary")], measured: { inputTokens: 5, estimated: true } });
    await expectMatchesBytePass(store);
    await store.appendForeignRecord({ type: "rewind", timestamp, userMessageId: "second", previousHeadId: "last", headId: "answer" });
    await expectMatchesBytePass(store);
});
