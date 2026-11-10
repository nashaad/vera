import { expect, test } from "bun:test";
import { appendFile, mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessionIndex } from "../../src/store/session-index-scan.ts";
import { SessionFieldScanner } from "../../src/store/session-json-fields.ts";
import { readIndexedLiveContext, readSessionTurnState, SessionStore } from "../../src/store/session-store.ts";

for (const [label, ending] of [["CRLF", "\r\n"], ["trailing spaces", "  \t\n"]] as const) {
    test(`opens and appends session records with ${label}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-index-whitespace-"));
        const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
        const first = await store.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] });
        await store.appendName("vessel");
        await store.appendContextMeasurement({ tokens: 1, estimated: true, projection: { estimatedTokens: 1,
            components: [{ kind: "message", id: "message:1", owner: "session", source: "user",
                displayName: "message", count: 1, estimatedTokens: 1 }] } });
        await store.appendCompaction({ boundaryMessageId: first.id, firstRetainedMessageId: null,
            projection: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
            measured: { inputTokens: 1, estimated: true } });
        const original = await readFile(store.path, "utf8");
        await writeFile(store.path, original.replaceAll("\n", ending));
        const reopened = await SessionStore.open(store.path);
        expect(reopened.name()).toBe("vessel");
        expect(reopened.latestContextMeasurement()?.tokens).toBe(1);
        expect(await reopened.readMessageEntry(first.id)).toEqual(first);
        const next = await reopened.appendMessage({ role: "user", content: [{ type: "text", text: "next" }] });
        expect((await SessionStore.open(store.path)).activeHeadId()).toBe(next.id);
    });
}

test("field scanning never reads beyond the supplied record", () => {
    const scanner = new SessionFieldScanner();
    const shared = Buffer.from('{"type":"session"}  \r\n{"type":"message"}');
    const end = shared.indexOf(10);
    expect(scanner.read(shared, false, 0, end)?.type).toBe("session");
    const stale = Buffer.from('{"type":"session"}');
    expect(scanner.read(stale, false, 0, stale.length - 1)).toBeUndefined();
    const incompleteNumber = Buffer.from('{"n":-0}');
    expect(scanner.read(incompleteNumber, false, 0, 6)).toBeUndefined();
});

test("scans index headers across an abandoned branch without retaining message bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-scan-"));
    let id = 0;
    const store = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "session", cwd: root, createId: () => `message-${++id}`,
    });
    const first = await store.appendMessage({ role: "user", content: [{ type: "text", text: "a".repeat(10000) }] });
    const second = await store.appendMessage({ role: "user", content: [{ type: "text", text: "two" }] });
    await store.rewindBefore(second.id);
    const last = await store.appendMessage({ role: "user", content: [{ type: "text", text: "replacement" }] });
    const scanned = await scanSessionIndex(store.path);
    expect(scanned.headId).toBe(last.id);
    expect(scanned.index.messageRecord(second.id)).toBeDefined();
    expect(scanned.index.messageId(scanned.index.parent(scanned.index.messageRecord(last.id)!)!)).toBe(first.id);
    expect(scanned.index.isVisibleUser(scanned.index.messageRecord(last.id)!)).toBe(true);
    expect(scanned.index.branchFacts(scanned.headId)).toEqual({ turns: store.turnCount(), firstUser: scanned.index.messageRecord(first.id) });
    expect(scanned.firstUser?.title).toBe(store.firstUserFacts()?.title);
    expect(scanned.latestMessageTimestamp).toBe(store.latestMessageTimestamp());
    expect(scanned.lineCount).toBe(5);
    expect(scanned.completeBytes).toBe(scanned.totalBytes);
    const reopened = await SessionStore.open(store.path);
    const projection = Reflect.get(reopened, "projection") as { activeMessageEntries: { id: string }[] };
    expect(Reflect.has(projection, "messageEntries")).toBe(false);
    expect(projection.activeMessageEntries.some((entry) => entry.id === second.id)).toBe(false);
    expect(await reopened.readMessageEntry(second.id)).toEqual(second);
    const expected = (await readFile(store.path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    const records = [];
    for await (const entry of reopened.walkRecords()) records.push(entry.record);
    expect(records).toEqual(expected);
    expect(await reopened.readRecord(2)).toEqual(expected[2]);
    expect(await reopened.readRecord(expected.length)).toBeUndefined();
    const messages = [];
    for await (const entry of reopened.walkRecords("message")) messages.push(entry.record);
    expect(messages).toEqual(expected.filter((entry) => entry.type === "message"));
    await store.rewindBefore(first.id);
    expect((await scanSessionIndex(store.path)).firstUser).toBeUndefined();
    await store.appendMessage({ role: "user", content: [{ type: "text", text: " new\n title " }] });
    expect((await scanSessionIndex(store.path)).firstUser?.title).toBe("new title");
});

test("repairs a partial tail before returning or reporting a complete-line error", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-tail-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    await appendFile(store.path, '{"type":"unfinished"');
    const scanned = await scanSessionIndex(store.path, undefined, true);
    expect(scanned.totalBytes).toBeGreaterThan(scanned.completeBytes);
    expect((await readFile(store.path, "utf8")).endsWith("\n")).toBe(true);
    await appendFile(store.path, '{"bad":}\nunfinished');
    await expect(scanSessionIndex(store.path, undefined, true)).rejects.toThrow("line 3 is not valid JSON");
    expect((await readFile(store.path, "utf8")).endsWith("\n")).toBe(true);
});

test("scans crash-recovery and queued-prompt facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-turn-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const check = async (): Promise<void> => {
        const indexed = await scanSessionIndex(store.path);
        const existing = await readSessionTurnState(store.path);
        expect(indexed.turnOpen).toBe(existing.turnOpen);
        expect(indexed.queuedPromptRecords.length > 0).toBe(existing.needsQueueRecovery);
        const live = await readIndexedLiveContext(store.path);
        expect(live.queuedPrompts).toEqual(store.queuedPrompts());
        expect(live.unsentPrompts).toEqual(store.unsentPrompts());
    };
    await check();
    await store.appendQueuedPrompt("queued", { content: "later" });
    await check();
    await store.removeQueuedPrompt("queued");
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "work" }] }, { turnStart: true });
    await check();
    await store.repairCrashedTurn();
    await check();
});

test("rejects an invalid older compact recipe even when a later keyframe is valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-invalid-recipe-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const component = { kind: "message", id: "m", owner: "session", source: "user", displayName: "message", count: 1, estimatedTokens: 4 };
    const measurement = { tokens: 4, estimated: true, projection: { estimatedTokens: 4, components: [component] } };
    const entry = { type: "context_measurement", timestamp: "now", afterMessageId: null, measurement,
        contextRecipe: { version: 1, keyframe: true, append: [component], update: [] } };
    const bad = { ...entry, contextRecipe: { ...entry.contextRecipe, version: 2 } };
    await appendFile(store.path, `${JSON.stringify(bad)}\n${JSON.stringify(entry)}\n`);
    expect((await scanSessionIndex(store.path)).canonicalMeasurements).toBe(false);
    await expect(SessionStore.open(store.path)).rejects.toThrow("line 2 is not a valid context measurement entry");
    await expect(readIndexedLiveContext(store.path)).rejects.toThrow("line 2 is not a valid context measurement entry");
});

test("reads harness and delivery records by offset after a rewind", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-decorations-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const user = await store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    await store.appendHarnessMessage("first notice", "soft");
    await store.recordDelivery({ id: "delivery", sourceAgentId: "source", content: "report" });
    await store.rewindBefore(user.id);
    await store.appendHarnessMessage("second notice", "error");
    const reopened = await SessionStore.open(store.path);
    const harness = [];
    for await (const item of reopened.walkHarnessMessages()) harness.push(item);
    expect(harness.map(({ ordinal, entry }) => [ordinal, entry.afterMessageId, entry.text])).toEqual([
        [0, user.id, "first notice"], [1, null, "second notice"],
    ]);
    expect(await reopened.readDelivery("delivery")).toMatchObject({ id: "delivery", content: "report" });
    expect(await reopened.readDelivery("missing")).toBeUndefined();
    expect(await reopened.readAttachmentName("missing")).toBeUndefined();
});

test("bounds resident harness history and reads older entries unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-harness-tail-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const user = await store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
    const originals = [];
    for (const character of ["a", "b", "c"]) originals.push(await store.appendHarnessMessage(character.repeat(80_000), "soft"));
    expect(store.projectedHarnessMessages().map((entry) => entry.id)).toEqual(["harness:0", "harness:1", "harness:2"]);
    await store.appendCompaction({ boundaryMessageId: user.id, firstRetainedMessageId: null,
        projection: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
        measured: { inputTokens: 1, estimated: true } });
    const reopened = await SessionStore.open(store.path);
    const resident = Reflect.get(reopened, "projection") as { harnessMessageEntries: unknown[]; harnessTailBytes: number };
    expect(resident.harnessTailBytes).toBeLessThanOrEqual(128 * 1024);
    expect(resident.harnessMessageEntries.length).toBe(1);
    const read = [];
    for await (const entry of reopened.walkHarnessMessages()) read.push(entry);
    expect(read.map((entry) => entry.entry)).toEqual(originals);
    expect(reopened.projectedHarnessMessages()).toEqual([]);
});

test("an oversized unanchored notice does not count as retained tail bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-oversized-harness-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    await store.appendHarnessMessage("x".repeat(140_000), "soft");
    const resident = Reflect.get(store, "projection") as { harnessMessageEntries: unknown[]; harnessTailBytes: number };
    expect(resident.harnessMessageEntries).toEqual([]);
    expect(resident.harnessTailBytes).toBe(0);
    await store.appendHarnessMessage("small", "soft");
    expect(resident.harnessMessageEntries.length).toBe(1);
    expect(resident.harnessTailBytes).toBeGreaterThan(0);
});

test("retains notices anchored in the live context across open and compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-live-harness-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const first = await store.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] });
    await store.appendHarnessMessage("early notice", "soft");
    const last = await store.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(140_000) }] });
    await store.appendHarnessMessage("last notice", "soft");
    const reopened = await SessionStore.open(store.path);
    expect(reopened.projectedHarnessMessages()).toMatchObject([
        { id: "harness:0", text: "early notice" }, { id: "harness:1", text: "last notice" },
    ]);
    await reopened.appendCompaction({ boundaryMessageId: first.id, firstRetainedMessageId: last.id,
        projection: [{ role: "user", content: [{ type: "text", text: "summary" }] }],
        measured: { inputTokens: 1, estimated: true } });
    expect(reopened.projectedHarnessMessages()).toMatchObject([{ id: "harness:1", text: "last notice" }]);
    expect((await SessionStore.open(store.path)).projectedHarnessMessages())
        .toMatchObject([{ id: "harness:1", text: "last notice" }]);
    const notices = [];
    for await (const { entry } of reopened.walkHarnessMessages()) notices.push(entry.text);
    expect(notices).toEqual(["early notice", "last notice"]);
});

test("restores older notices if a compaction expands the live context", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-expanded-harness-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const first = await store.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] });
    const second = await store.appendMessage({ role: "user", content: [{ type: "text", text: "second" }] });
    await store.appendHarnessMessage("a".repeat(80_000), "soft");
    await store.appendHarnessMessage("b".repeat(80_000), "soft");
    const last = await store.appendMessage({ role: "user", content: [{ type: "text", text: "last" }] });
    await store.appendHarnessMessage("last notice", "soft");
    const projection = [{ role: "user" as const, content: [{ type: "text" as const, text: "summary" }] }];
    const measured = { inputTokens: 1, estimated: true };
    await store.appendCompaction({ boundaryMessageId: last.id, firstRetainedMessageId: null, projection, measured });
    const resident = Reflect.get(store, "projection") as { harnessMessageEntries: unknown[] };
    expect(resident.harnessMessageEntries.length).toBe(2);
    await store.appendCompaction({ boundaryMessageId: first.id, firstRetainedMessageId: second.id, projection, measured });
    expect(store.liveMessageEntries().map((entry) => entry.id)).toEqual([second.id, last.id]);
    expect(store.projectedHarnessMessages().map((entry) => entry.id)).toEqual(["harness:0", "harness:1", "harness:2"]);
    const reopened = await SessionStore.open(store.path);
    expect(reopened.projectedHarnessMessages()).toEqual(store.projectedHarnessMessages());
    expect(reopened.modelContext()).toEqual([...store.modelContext()]);
});

test("a rewind reads the final timestamp field without decoding an old body", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-rewound-timestamp-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const first = await store.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(140_000) }] });
    const second = await store.appendMessage({ role: "user", content: [{ type: "text", text: "second" }] });
    await store.rewindBefore(second.id);
    const lines = (await readFile(store.path, "utf8")).trimEnd().split("\n");
    const record = JSON.parse(lines[1]!);
    lines[1] = `{"timestamp":"old","message":${JSON.stringify(record.message)},"id":${JSON.stringify(first.id)},"parentId":null,"type":"message","time\\u0073tamp":"new timestamp"}`;
    await writeFile(store.path, `${lines.join("\n")}\n`);
    expect((await scanSessionIndex(store.path)).latestMessageTimestamp).toBe("new timestamp");
    expect((await SessionStore.open(store.path)).latestMessageTimestamp()).toBe("new timestamp");
});

test("the index scan keeps its supplied file when the path is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-replaced-"));
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "original", cwd: root });
    const first = await store.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] });
    const second = await store.appendMessage({ role: "user", content: [{ type: "text", text: "second" }] });
    await store.rewindBefore(second.id);
    const file = await open(path, "r");
    try {
        await rename(path, `${path}.old`);
        await SessionStore.create(path, { sessionId: "replacement", cwd: root });
        const scanned = await scanSessionIndex(path, file);
        expect(scanned.header.id).toBe("original");
        expect(scanned.headId).toBe(first.id);
        expect(scanned.latestMessageTimestamp).toBe(first.timestamp);
    } finally {
        await file.close();
    }
});

test("ASCII header shortcuts preserve duplicate and escaped field semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-index-ascii-header-"));
    const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "session", cwd: root });
    const message = JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const lines = [JSON.stringify(store.header),
        `{"type":"message","id":"shadow","parentId":null,"timestamp":"${timestamp}","message":${message},"id":"actual"}`,
        `{"type":"message","id":"second","parentId":"wrong","timestamp":"${timestamp}","message":${message},"parentId":"actual"}`,
        `{"type":"message","id":"escaped-\\ud800","parentId":"second","timestamp":"${timestamp}","message":${message}}`,
    ];
    await writeFile(store.path, `${lines.join("\n")}\n`);
    const scanned = await scanSessionIndex(store.path);
    const reopened = await SessionStore.open(store.path);
    expect(scanned.headId).toBe("escaped-\ud800");
    expect(scanned.index.messageRecord("shadow")).toBeUndefined();
    expect(scanned.index.messageId(scanned.index.parent(scanned.index.messageRecord("second")!)!)).toBe("actual");
    expect(scanned.headId).toBe(reopened.activeHeadId());
    expect(scanned.turnCount).toBe(reopened.turnCount());
});
