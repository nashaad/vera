import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleAgedToolResults } from "../../src/engine/tool-result-history.ts";
import { WorkerSessionStore } from "../../src/host/worker/session.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { createSessionBranch } from "../../src/store/session-branch.ts";
import { SessionReplica } from "../../src/store/session-replica.ts";
import { searchSessionFile, searchSessions } from "../../src/store/session-search.ts";
import { SessionStore, type SessionDeliveryEntry, type SessionMessageEntry } from "../../src/store/session-store.ts";

const roots: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
    const path = mkdtempSync(join(tmpdir(), "vera-store-cpu-"));
    roots.push(path);
    return path;
}

function header(): Record<string, unknown> {
    return { type: "session", version: 1, id: "crow", timestamp, cwd: "/work" };
}

function user(text: string, internal = false): ModelMessage {
    return { role: "user", ...(internal ? { internal: true } : {}), content: [{ type: "text", text }] };
}

function assistant(text: string): ModelMessage {
    return {
        role: "assistant", content: [{ type: "text", text }],
        source: { provider: "test", api: "test", model: "test" },
        usage: emptyUsage(), stopReason: "stop",
    };
}

function toolCall(index: number): ModelMessage {
    return {
        role: "assistant", content: [{ type: "tool_call", id: `t${index}`, name: "read", input: { path: `map${index}` } }],
        source: { provider: "test", api: "test", model: "test" },
        usage: emptyUsage(), stopReason: "tool_use",
    };
}

function toolResult(index: number): ModelMessage {
    return { role: "tool_result", toolCallId: `t${index}`, toolName: "read", content: [{ type: "text", text: `map ${index}` }], isError: false };
}

function writeRecords(path: string, records: readonly object[]): void {
    writeFileSync(path, [header(), ...records].map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function oldActive(entries: readonly SessionMessageEntry[], headId: string | null): SessionMessageEntry[] {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch: SessionMessageEntry[] = [];
    let id = headId;
    while (id !== null) {
        const entry = byId.get(id);
        if (entry === undefined) throw new Error(`missing ${id}`);
        branch.push(entry);
        id = entry.parentId;
    }
    return branch.reverse();
}

interface ReferenceReplay {
    readonly entries: SessionMessageEntry[];
    readonly deliveries: SessionDeliveryEntry[];
    readonly receipts: Set<string>;
    readonly legacy: Map<string, string>;
    headId: string | null;
}

function oldReplay(records: readonly Record<string, unknown>[]): ReferenceReplay {
    const state: ReferenceReplay = { entries: [], deliveries: [], receipts: new Set(), legacy: new Map(), headId: null };
    for (const record of records) {
        if (record.type === "message" || record.type === "turn_start") {
            const entry = { ...record, type: "message" } as unknown as SessionMessageEntry;
            if (entry.deliveryId !== undefined && oldActive(state.entries, state.headId).some((item) => item.deliveryId === entry.deliveryId)) {
                throw new Error(`repeated delivery ${entry.deliveryId}`);
            }
            state.entries.push(entry);
            state.headId = entry.id;
        } else if (record.type === "delivery") {
            state.deliveries.push(record as unknown as SessionDeliveryEntry);
        } else if (record.type === "delivery_receipt") {
            const deliveryId = record.deliveryId as string;
            state.receipts.add(deliveryId);
            const activeHead = state.entries.find((entry) => entry.id === state.headId);
            if (activeHead !== undefined && activeHead.deliveryId === undefined
                && activeHead.message.role === "user" && activeHead.message.internal === true) {
                state.legacy.set(deliveryId, activeHead.id);
            }
        } else if (record.type === "rewind") {
            const boundary = oldActive(state.entries, state.headId).find((entry) => entry.id === record.userMessageId);
            if (boundary === undefined || boundary.parentId !== record.headId) throw new Error("invalid rewind");
            state.headId = boundary.parentId;
        }
    }
    return state;
}

function oldPending(state: ReferenceReplay): readonly SessionDeliveryEntry[] {
    const active = oldActive(state.entries, state.headId);
    const ids = new Set(active.map((entry) => entry.id));
    const delivered = new Set(active.flatMap((entry) => entry.deliveryId === undefined ? [] : [entry.deliveryId]));
    return state.deliveries.filter((entry) => {
        const legacyId = state.legacy.get(entry.id);
        return !(state.receipts.has(entry.id) && (legacyId === undefined || ids.has(legacyId))) && !delivered.has(entry.id);
    });
}

function oldRetainedMeasurements(active: readonly SessionMessageEntry[], afterIds: readonly (string | null)[]): Set<number> {
    const positions = new Map(active.map((entry, index) => [entry.id, index]));
    const points = new Set<number>([-1]);
    if (active.length > 0) points.add(active.length - 1);
    for (const entry of active) {
        if (entry.message.role === "user" && entry.message.internal !== true) {
            points.add(entry.parentId === null ? -1 : positions.get(entry.parentId) ?? -1);
        }
    }
    const latestAt = new Map<number, number>();
    let latestNull = -1;
    afterIds.forEach((id, index) => {
        if (id === null) latestNull = index;
        else {
            const position = positions.get(id);
            if (position !== undefined) latestAt.set(position, index);
        }
    });
    const ordered = [...latestAt.keys()].sort((left, right) => left - right);
    const kept = new Set<number>();
    let running = latestNull;
    let cursor = 0;
    for (const point of [...points].sort((left, right) => left - right)) {
        while (cursor < ordered.length && ordered[cursor]! <= point) {
            running = Math.max(running, latestAt.get(ordered[cursor]!)!);
            cursor += 1;
        }
        if (running >= 0) kept.add(running);
    }
    return kept;
}

function largeRecords(): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    const active: string[] = [];
    let next = 0;
    const add = (message: ModelMessage, deliveryId?: string): string => {
        const id = `m${next++}`;
        records.push({ type: "message", id, parentId: active.at(-1) ?? null, timestamp, ...(deliveryId === undefined ? {} : { deliveryId }), message });
        active.push(id);
        return id;
    };
    for (let index = 0; index < 480; index += 1) {
        const boundary = add(user(`request ${index}`));
        add(toolCall(index));
        add(toolResult(index));
        records.push({ type: "delivery", id: `d${index}`, sourceAgentId: "crow", content: "found", timestamp });
        add(user("delivery", true), `d${index}`);
        add(user("legacy", true));
        records.push({ type: "delivery", id: `l${index}`, sourceAgentId: "crow", content: "old", timestamp });
        records.push({ type: "delivery_receipt", deliveryId: `l${index}`, timestamp });
        if (index % 24 === 23) {
            const position = active.indexOf(boundary);
            records.push({ type: "rewind", userMessageId: boundary, previousHeadId: active.at(-1), headId: active[position - 1] ?? null, timestamp });
            active.length = position;
        }
    }
    return records;
}

test("large session replay matches the previous branch and delivery scans", async () => {
    const path = join(root(), "session.jsonl");
    const records = largeRecords();
    writeRecords(path, records);
    const before = readFileSync(path, "utf8");
    const reference = oldReplay(records);
    const expected = oldActive(reference.entries, reference.headId);
    const store = await SessionStore.open(path);
    const replica = SessionReplica.seed(path, header());
    for (let index = 0; index < records.length; index += 1) {
        replica.apply(index + 2, records[index]!);
        if (index % 480 === 0) {
            const prefix = oldReplay(records.slice(0, index + 1));
            expect(replica.activeEntries()).toEqual(oldActive(prefix.entries, prefix.headId));
            expect(replica.pendingDeliveries()).toEqual(oldPending(prefix));
        }
    }

    for (const actual of [store, replica]) {
        expect(actual.entries()).toEqual(reference.entries);
        expect(actual.activeEntries()).toEqual(expected);
        expect(actual.activeHeadId()).toBe(reference.headId);
        expect(actual.pendingDeliveries()).toEqual(oldPending(reference));
        expect(JSON.stringify(actual.unprojectedModelContext())).toBe(JSON.stringify(expected.map((entry) => entry.message)));
        expect(JSON.stringify(actual.modelContext())).toBe(JSON.stringify(assembleAgedToolResults(expected, {})));
    }
    expect(readFileSync(path, "utf8")).toBe(before);
});

test("large measurement replay retains the previous results at every rewind point", async () => {
    const path = join(root(), "session.jsonl");
    const records: object[] = [];
    const afterIds: (string | null)[] = [];
    const addMeasurement = (afterMessageId: string | null): void => {
        const tokens = afterIds.length + 1;
        afterIds.push(afterMessageId);
        records.push({
            type: "context_measurement", timestamp, afterMessageId,
            measurement: { tokens, estimated: true, projection: { estimatedTokens: tokens, components: [{ kind: "message", id: "message:1", owner: "session", source: "user", displayName: "message", count: 1, estimatedTokens: tokens }] } },
        });
    };
    let previous: string | null = null;
    for (let index = 0; index < 1200; index += 1) {
        const id = `measurement-message-${index}`;
        records.push({ type: "message", id, parentId: previous, timestamp, message: index % 4 === 0 ? user(`question ${index}`) : assistant(`answer ${index}`) });
        addMeasurement(id);
        if (index % 19 === 0) addMeasurement(index === 0 ? null : `measurement-message-${index - 1}`);
        previous = id;
    }
    writeRecords(path, records);
    const store = await SessionStore.open(path);
    const check = async (): Promise<void> => {
        const kept = oldRetainedMeasurements(store.activeEntries(), afterIds);
        const expected = afterIds.flatMap((_id, index) => kept.has(index) ? [index + 1] : []);
        const actual = (store as unknown as { projection: { contextMeasurementEntries: Array<{ measurement: { tokens: number } }> } }).projection.contextMeasurementEntries;
        expect(actual.map((entry) => entry.measurement.tokens)).toEqual(expected);
        expect((await SessionStore.open(path)).latestContextMeasurement()).toEqual(store.latestContextMeasurement());
    };
    await check();
    for (const index of [1000, 800, 600, 400, 200, 0]) {
        await store.rewindBefore(`measurement-message-${index}`);
        await check();
    }
});

test("branch reads track durable append, foreign records, compaction, rewind, branch and repair", async () => {
    const directory = root();
    const path = join(directory, "session.jsonl");
    let id = 0;
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: "/work", now: () => new Date(timestamp), createId: () => `id${++id}` });
    const check = async (): Promise<void> => {
        const expected = oldActive(store.entries(), store.activeHeadId());
        expect(store.activeEntries()).toEqual(expected);
        expect((await SessionStore.open(path)).activeEntries()).toEqual(expected);
    };
    const first = await store.appendMessage(user("first"));
    const firstAnswer = await store.appendMessage(assistant("answer"));
    await check();
    const second = await store.appendMessage(user("second"));
    const secondAnswer = await store.appendMessage(assistant("another answer"));
    await check();
    await store.appendCompaction({ boundaryMessageId: firstAnswer.id, firstRetainedMessageId: second.id, projection: [assistant("summary")], measured: { inputTokens: 5, estimated: true } });
    expect(store.modelContext()).toEqual([assistant("summary"), second.message, secondAnswer.message]);
    await check();
    await store.appendForeignRecord({ type: "message", id: "foreign", parentId: secondAnswer.id, timestamp, message: user("foreign") });
    await check();
    const before = readFileSync(path, "utf8");
    await expect(store.appendForeignRecord({ type: "rewind", userMessageId: second.id, previousHeadId: "foreign", headId: null, timestamp })).rejects.toThrow("wrong rewind target");
    expect(readFileSync(path, "utf8")).toBe(before);
    await check();
    await store.appendForeignRecord({ type: "rewind", userMessageId: second.id, previousHeadId: "foreign", headId: firstAnswer.id, timestamp });
    await check();
    const replacement = await store.appendMessage(user("replacement"), { turnStart: true });
    await store.appendMessage(toolCall(1));
    await check();
    expect(await store.repairCrashedTurn()).toBe(true);
    await check();
    const branch = await createSessionBranch({ source: store, destinationPath: join(directory, "branch.jsonl"), sessionId: "branch", position: "at" });
    expect(branch.store.messages()).toEqual(store.messages());
    expect((await SessionStore.open(branch.store.path)).messages()).toEqual(store.messages());
    await store.rewindBefore(replacement.id);
    await check();
    await store.rewindBefore(first.id);
    await check();
});

test("delivery indexes follow live appends, rejected foreign writes and rewinds", async () => {
    const path = join(root(), "session.jsonl");
    let id = 0;
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: "/work", createId: () => `m${++id}` });
    const first = await store.appendMessage(user("first"));
    await store.recordDelivery({ id: "delivery", sourceAgentId: "crow", content: "report" });
    const delivered = await store.appendDeliveryMessage("delivery", user("report", true));
    store.activeEntries();
    const repeated = { type: "message", id: "repeat", parentId: delivered.id, timestamp, deliveryId: "delivery", message: user("report", true) };
    const before = readFileSync(path, "utf8");
    await expect(store.appendForeignRecord(repeated)).rejects.toThrow("repeats active delivery delivery");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(store.pendingDeliveries()).toEqual([]);
    await store.rewindBefore(first.id);
    expect(store.pendingDeliveries().map((entry) => entry.id)).toEqual(["delivery"]);
    await store.appendForeignRecord({ ...repeated, parentId: null });
    expect(store.pendingDeliveries()).toEqual([]);
    expect((await SessionStore.open(path)).activeEntries()).toEqual(store.activeEntries());
});

test("reopening after an external file change builds the current branch", async () => {
    const path = join(root(), "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: "/work", createId: () => "first" });
    await store.appendMessage(user("first"));
    expect(store.activeEntries().map((entry) => entry.id)).toEqual(["first"]);
    appendFileSync(path, JSON.stringify({ type: "message", id: "external", parentId: "first", timestamp, message: user("second") }) + "\n");
    const reopened = await SessionStore.open(path);
    expect(reopened.activeEntries().map((entry) => entry.id)).toEqual(["first", "external"]);
    expect(store.activeEntries().map((entry) => entry.id)).toEqual(["first"]);
});

test("worker-owned and host-ingested branch changes keep the same active entries", async () => {
    const path = join(root(), "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: "/work", createId: () => "host" });
    const worker = WorkerSessionStore.seed(path, header());
    worker.setAppender((record) => store.appendForeignRecord(record));
    worker.activeEntries();
    await worker.appendMessage(user("worker"));
    expect(worker.activeEntries()).toEqual(store.activeEntries());
    const hostEntry = await store.appendMessage(user("host"));
    worker.applyHostRecord(store.appendedLineCount(), hostEntry as unknown as Record<string, unknown>);
    expect(worker.activeEntries()).toEqual(store.activeEntries());
    const rewind = await store.rewindBefore(hostEntry.id);
    worker.applyHostRecord(store.appendedLineCount(), rewind as unknown as Record<string, unknown>);
    expect(worker.activeEntries()).toEqual(store.activeEntries());
    expect((await SessionStore.open(path)).activeEntries()).toEqual(worker.activeEntries());
});

test("aborted and exited worker repairs preserve the active branch snapshot", async () => {
    const directory = root();
    for (const mode of ["aborted", "exited"] as const) {
        const path = join(directory, `${mode}.jsonl`);
        const store = await SessionStore.create(path, { sessionId: mode, cwd: "/work" });
        await store.appendMessage(user("first"), { turnStart: true });
        await store.appendMessage(toolCall(7));
        store.activeEntries();
        const repaired = mode === "aborted"
            ? await store.finishAbortedTurn()
            : await store.repairCrashedTurn({ workerExited: true });
        expect(repaired).toBe(true);
        const entries = store.activeEntries();
        expect(entries.map((entry) => entry.message.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
        expect(entries.at(-1)?.message).toMatchObject({ role: "assistant", source: { provider: "test", api: "test", model: "test" }, stopReason: mode === "aborted" ? "aborted" : "error" });
        expect((await SessionStore.open(path)).activeEntries()).toEqual(entries);
    }
});

test("mutating returned entries and replica input cannot corrupt the active branch index", async () => {
    const path = join(root(), "session.jsonl");
    let observed: Record<string, unknown> | undefined;
    const store = await SessionStore.create(path, {
        sessionId: "crow", cwd: "/work", createId: () => "first",
        onRecordAppended: (_line, record) => { observed = record; },
    });
    const appended = await store.appendMessage(user("first"));
    const active = store.activeEntries() as SessionMessageEntry[];
    const entries = store.entries() as SessionMessageEntry[];
    (active[0] as { id: string }).id = "changed-active";
    (entries[0] as { parentId: string | null }).parentId = "changed-parent";
    (appended as { id: string }).id = "changed-append";
    observed!.id = "changed-observed";
    active.push(active[0]!);
    expect(store.activeEntries().map((entry) => [entry.id, entry.parentId])).toEqual([["first", null]]);
    expect(store.entries().map((entry) => [entry.id, entry.parentId])).toEqual([["first", null]]);
    expect((await SessionStore.open(path)).activeEntries()).toEqual(store.activeEntries());

    const replica = SessionReplica.seed(path, header());
    const record = { type: "message", id: "replica", parentId: null, timestamp, message: user("first") };
    replica.apply(2, record);
    replica.activeEntries();
    record.id = "changed-record";
    expect(replica.activeEntries().map((entry) => entry.id)).toEqual(["replica"]);
});

test("attachment replay and live indexing retain the first matching metadata", async () => {
    const path = join(root(), "session.jsonl");
    const attachments = Array.from({ length: 800 }, (_, index) => {
        const sha256 = index.toString(16).padStart(64, "0");
        return { id: `${sha256}.png`, name: `map${index}.png`, mediaType: "image/png" as const, bytes: 10, width: 2, height: 2, sha256 };
    });
    const duplicates = attachments.slice().reverse().map((attachment) => ({ ...attachment, name: `other-${attachment.name}` }));
    const records = [...attachments, ...duplicates].map((attachment) => ({ type: "attachment", timestamp, attachment }));
    writeRecords(path, records);
    const store = await SessionStore.open(path);
    expect(store.attachmentRecords()).toEqual(attachments);
    expect(await store.appendAttachment({ ...attachments[0]!, name: "different.png" })).toEqual(attachments[0]!);
    await store.appendForeignRecord(records[0]!);
    await expect(store.appendForeignRecord({ ...records[1]!, attachment: { ...attachments[1]!, width: 3 } })).rejects.toThrow("repeats attachment ID");
    expect(store.attachmentRecords()).toEqual(attachments);

    let observed: Record<string, unknown> | undefined;
    store.watchRecords((_line, record) => { observed = record; });
    const sha256 = "f".repeat(64);
    const last = { id: `${sha256}.png`, name: "last.png", mediaType: "image/png" as const, bytes: 10, width: 2, height: 2, sha256 };
    await store.appendAttachment(last);
    (observed!.attachment as { id: string }).id = "changed";
    expect(await store.appendAttachment(last)).toEqual(last);
    expect(store.attachmentRecords()).toEqual([...attachments, last]);
    expect((await SessionStore.open(path)).attachmentRecords()).toEqual([...attachments, last]);
});

test("replay keeps delivery and rewind errors after changing branches", async () => {
    const directory = root();
    const delivery = { type: "delivery", id: "d", sourceAgentId: "crow", content: "report", timestamp };
    const first = { type: "message", id: "u", parentId: null, timestamp, message: user("first") };
    const delivered = { type: "message", id: "d1", parentId: "u", timestamp, deliveryId: "d", message: user("report", true) };
    const second = { type: "message", id: "u2", parentId: "d1", timestamp, message: user("second") };
    const rewind = { type: "rewind", userMessageId: "u", previousHeadId: "u2", headId: null, timestamp };
    const cases: Array<{ records: object[]; error: string }> = [
        { records: [first, delivery, delivered, { ...delivered, id: "d2", parentId: "d1" }], error: "line 5 repeats active delivery d" },
        { records: [first, delivery, delivered, second, rewind, { ...rewind, previousHeadId: "u2" }], error: "line 7 rewinds from inactive head u2" },
        { records: [first, delivery, delivered, second, rewind, { ...first, id: "new", parentId: null }, { ...rewind, previousHeadId: "new" }], error: "line 8 does not reference an active user message u" },
        { records: [first, delivery, delivered, second, { ...rewind, headId: "d1" }], error: "line 6 has the wrong rewind target" },
        { records: [first, { type: "delivery_receipt", deliveryId: "missing", timestamp }], error: "line 3 references missing delivery missing" },
        { records: [first, delivery, { type: "delivery_receipt", deliveryId: "d", timestamp }, { type: "delivery_receipt", deliveryId: "d", timestamp }], error: "line 5 repeats delivery receipt d" },
    ];
    for (let index = 0; index < cases.length; index += 1) {
        const path = join(directory, `${index}.jsonl`);
        writeRecords(path, cases[index]!.records);
        await expect(SessionStore.open(path)).rejects.toThrow(cases[index]!.error);
    }
    const path = join(directory, "reused.jsonl");
    writeRecords(path, [first, delivery, delivered, second, rewind, { ...delivered, id: "d2", parentId: null }]);
    const reopened = await SessionStore.open(path);
    expect(reopened.activeEntries().map((entry) => entry.id)).toEqual(["d2"]);
    expect(reopened.pendingDeliveries()).toEqual([]);
});

function searchableMessage(id: string, role: string, content: readonly object[]): Record<string, unknown> {
    return { type: "message", id, parentId: null, timestamp, message: { role, content } };
}

function forceParse(line: string): string {
    try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return JSON.stringify({ ...parsed, prefilterControl: "\n" });
        }
    } catch {}
    return line;
}

async function comparableSearch(path: string, query: string, kind?: "messages" | "tools" | "files") {
    const found = await searchSessionFile(path, timestamp, query.trim().toLowerCase(), { query, ...(kind === undefined ? {} : { kind }) }, 20);
    return found === undefined ? undefined : { ...found, session_path: "same" };
}

test("search matches a full-parse reference on large files, escapes, case folding and file changes", async () => {
    const directory = root();
    const path = join(directory, "search.jsonl");
    const referencePath = join(directory, "full-parse.jsonl");
    const lines = [JSON.stringify(header()), JSON.stringify(searchableMessage("title", "user", [{ type: "text", text: "A crow studies maps" }]))];
    for (let index = 0; index < 4000; index += 1) {
        lines.push(JSON.stringify(searchableMessage(`m${index}`, "assistant", [{ type: "text", text: index % 127 === 0 ? `needle ${index}` : `ordinary deck report ${index}` }])));
    }
    lines.push(
        JSON.stringify(searchableMessage("escaped", "assistant", [{ type: "text", text: 'quote "map" slash \\ and\nneedle' }])),
        JSON.stringify(searchableMessage("unicode", "assistant", [{ type: "text", text: "ΟΣ İ TREASURE" }])),
        '{"type":"message","id":"encoded","message":{"role":"assistant","content":[{"type":"text","text":"\\u0054reasure\\u0020map"}]}}',
        JSON.stringify(searchableMessage("tool", "assistant", [{ type: "tool_call", name: "bash", input: { command: "sail north", path: "maps/harbor" } }])),
        JSON.stringify({ type: "session_name", name: "named after the hits" }),
        JSON.stringify({ type: "session_name", name: null }),
        '{"type":"message","type":"session_name","name":"last name"}',
        "{ malformed",
    );
    writeFileSync(path, lines.join("\n") + "\n");
    writeFileSync(referencePath, lines.map(forceParse).join("\n") + "\n");
    for (const [query, kind] of [
        ["needle", undefined], ["treasure map", undefined], ["quote \"map\"", undefined],
        ["slash \\", undefined], ["and needle", undefined], ["ος", undefined], ["i\u0307", undefined],
        ["bash sail", "tools"], ["maps/harbor", "files"], ["absent", undefined], ["needle", "messages"],
    ] as const) {
        expect(await comparableSearch(path, query, kind)).toEqual(await comparableSearch(referencePath, query, kind));
    }
    expect((await comparableSearch(path, "treasure map"))?.hits[0]?.entry_id).toBe("encoded");
    expect((await comparableSearch(path, "ος"))?.hits[0]?.entry_id).toBe("unicode");
    expect((await comparableSearch(path, "bash sail", "tools"))?.hits[0]?.entry_id).toBe("tool");
    expect((await comparableSearch(path, "needle"))?.title).toBe("last name");
    const added = JSON.stringify(searchableMessage("new", "assistant", [{ type: "text", text: "fresh cargo" }]));
    appendFileSync(path, added + "\n");
    appendFileSync(referencePath, forceParse(added) + "\n");
    expect(await comparableSearch(path, "fresh cargo")).toEqual(await comparableSearch(referencePath, "fresh cargo"));
    expect((await comparableSearch(path, "fresh cargo"))?.hits[0]?.entry_id).toBe("new");
    expect((await comparableSearch(path, "needle"))?.hits).toHaveLength(20);
});

test("search preserves errors from null message records", async () => {
    const path = join(root(), "search.jsonl");
    const lines = [
        JSON.stringify(header()),
        JSON.stringify(searchableMessage("title", "user", [{ type: "text", text: "title" }])),
        '{"type":"message", "message" : null}',
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    await expect(comparableSearch(path, "absent")).rejects.toThrow();
});

test("search preserves the twenty-session cap and ordering against full parsing", async () => {
    const directory = root();
    const original = join(directory, "original");
    const reference = join(directory, "reference");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(original);
    mkdirSync(reference);
    for (let index = 0; index < 25; index += 1) {
        const lines = [JSON.stringify({ ...header(), id: `crow${index}` }), JSON.stringify(searchableMessage("m", "user", [{ type: "text", text: "treasure" }]))];
        for (const [folder, contents] of [[original, lines], [reference, lines.map(forceParse)]] as const) {
            const path = join(folder, `s${index}.jsonl`);
            writeFileSync(path, contents.join("\n") + "\n");
            const when = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
            utimesSync(path, when, when);
        }
    }
    const normalize = (result: Awaited<ReturnType<typeof searchSessions>>) => ({ ...result, results: result.results.map((item) => ({ ...item, session_path: "same" })) });
    const found = await searchSessions(original, { query: "treasure" });
    expect(normalize(found)).toEqual(normalize(await searchSessions(reference, { query: "treasure" })));
    expect(found.results).toHaveLength(20);
    expect(found.truncated).toBe(true);
});
