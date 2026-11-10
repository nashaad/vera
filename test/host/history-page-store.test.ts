import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { projectTranscript } from "../../src/engine/protocol.ts";
import { historyPageFromEntries, historyPageFromStore } from "../../src/host/history-page.ts";
import { walkSessionTranscript } from "../../src/session-transcript.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-history-page-"));
    temporaryDirectories.push(directory);
    return directory;
}

function userMessage(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
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

function scripted<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) throw new Error("No scripted value remains");
        return item;
    };
}

test("a rewound cursor pages its own chain and reports the active head", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: directory,
        now: () => new Date("2026-11-04T12:00:00.000Z"),
        createId: scripted(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    await store.appendMessage(userMessage("one"));
    await store.appendMessage(assistantMessage("two"));
    await store.appendMessage(userMessage("three"));
    await store.appendMessage(assistantMessage("four"));
    await store.rewindBefore("message-3");
    await store.appendMessage(userMessage("replacement"));

    expect(store.activeHeadId()).toBe("message-5");
    const abandoned = [];
    for await (const entry of store.walkMessageBranch("message-4")) abandoned.push(entry.message);
    expect(abandoned.map((message) =>
        message.content[0]?.type === "text" ? message.content[0].text : ""
    )).toEqual(["one", "two", "three", "four"]);
    expect(await store.readMessageEntry("missing")).toBeUndefined();

    const page = await historyPageFromStore(store, "message-3#0");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.entries.map((entry) => entry.id)).toEqual([
        "message-1#0",
        "message-2#0",
    ]);
    expect(page.page).toEqual({
        pageVersion: 1,
        hasMore: false,
        headId: "message-5",
        tailId: "message-2#0",
    });

    expect(await historyPageFromStore(store, "missing#0")).toEqual({
        kind: "cursor_not_found",
    });
});

test("a reopened store returns reasoning in its host history page", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "reasoning.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "reasoning-session",
        cwd: directory,
        createId: scripted("user-one", "reply-one", "user-two"),
    });
    await store.appendMessage(userMessage("find the island"));
    await store.appendMessage({
        role: "assistant",
        content: [
            { type: "thinking", text: "follow the stars", signature: "opaque" },
            { type: "text", text: "sail north" },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
    await store.appendMessage(userMessage("continue"));
    const reopened = await SessionStore.open(path);
    const page = await historyPageFromStore(reopened, "user-two#0");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.entries.map(({ kind }) => kind)).toEqual(["user", "reasoning", "assistant"]);
    expect(page.entries[1]).toMatchObject({ kind: "reasoning", id: "reply-one#r0", text: "follow the stars" });
    expect(page.entries[2]).toMatchObject({ kind: "assistant", id: "reply-one#0", text: "sail north" });
    expect(JSON.stringify(page)).not.toContain("opaque");
});

test("a reopened store pages through a split turn without dropping its prefix", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "long-turn.jsonl");
    let nextId = 0;
    const store = await SessionStore.create(path, {
        sessionId: "long-turn",
        cwd: directory,
        createId: () => `message-${nextId++}`,
    });
    await store.appendMessage(userMessage("find the island"));
    for (let index = 0; index < 125; index += 1) {
        await store.appendMessage({
            role: "assistant",
            content: [{ type: "tool_call", id: `call-${index}`, name: "read", input: {} }],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendMessage({
            role: "tool_result",
            toolCallId: `call-${index}`,
            toolName: "read",
            content: [{ type: "text", text: "charted" }],
            isError: false,
        });
    }
    const reopened = await SessionStore.open(path);
    const entries = projectTranscript(reopened.messages(), undefined, reopened.activeMessageStamps());
    let page = historyPageFromEntries(entries);
    if (page.kind !== "page") throw new Error("expected a tail page");
    const pages = [page.entries];
    while (page.page.hasMore) {
        const before = page.page.olderBefore;
        if (before === undefined) throw new Error("missing page cursor");
        page = await historyPageFromStore(reopened, before);
        if (page.kind !== "page") throw new Error(`expected a page, got ${page.kind}`);
        pages.unshift(page.entries);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat().map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
}, 30_000);

test("indexed pages match the full transcript without reading the whole chain", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "many.jsonl");
    const created = await SessionStore.create(path, { sessionId: "many", cwd: directory });
    const records: object[] = [created.header];
    for (let number = 0; number < 1200; number += 1) {
        const message = number % 47 === 0 ? userMessage(`turn ${number}`) : assistantMessage(`reply ${number}`);
        records.push({ type: "message", id: `entry-${number}`, parentId: number === 0 ? null : `entry-${number - 1}`,
            timestamp: "2026-11-04T12:00:00.000Z", message });
    }
    await Bun.write(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const store = await SessionStore.open(path);
    const full = projectTranscript(store.messages(), undefined, store.activeMessageStamps());
    const original = store.walkMessageAncestors.bind(store);
    let reads = 0;
    store.walkMessageAncestors = async function* (id) {
        for await (const entry of original(id)) {
            reads += 1;
            yield entry;
        }
    };
    for (const number of [1199, 998, 700, 321, 1]) {
        reads = 0;
        const cursor = `entry-${number}#0`;
        const end = full.findLastIndex((entry) => entry.id?.startsWith(`entry-${number}#`)) + 1;
        const expected = historyPageFromEntries(full.slice(0, end), cursor, { headId: store.activeHeadId()! });
        expect(await historyPageFromStore(store, cursor)).toEqual(expected);
        if (number === 1199) expect(reads).toBeLessThan(600);
    }
});

test("indexed pages preserve harness placement and abandoned branches", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "harness.jsonl");
    const created = await SessionStore.create(path, { sessionId: "harness", cwd: directory });
    const timestamp = "2026-11-04T12:00:00.000Z";
    const records: object[] = [created.header, { type: "harness_message", timestamp, afterMessageId: null, text: "initial", tone: "soft" }];
    for (let number = 0; number < 600; number += 1) {
        const message: ModelMessage = number % 40 === 0 ? userMessage(`turn ${number}`)
            : number % 17 === 0 ? { role: "user", internal: true, content: [{ type: "text", text: "hidden" }] }
            : assistantMessage(`reply ${number}`);
        records.push({ type: "message", id: `entry-${number}`, parentId: number === 0 ? null : `entry-${number - 1}`, timestamp, message });
        if (number % 17 === 0 || number % 31 === 0) {
            records.push({ type: "harness_message", timestamp, afterMessageId: `entry-${number}`,
                text: `notice ${number}`, tone: "soft", ...(number % 62 === 0 ? { crashCut: true } : {}) });
        }
    }
    records.push({ type: "rewind", timestamp, userMessageId: "entry-560", previousHeadId: "entry-599", headId: "entry-559" });
    records.push({ type: "message", id: "replacement", parentId: "entry-559", timestamp, message: userMessage("replacement") });
    await Bun.write(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const store = await SessionStore.open(path);
    const full = projectTranscript(store.messages(), undefined, store.activeMessageStamps(), store.projectedHarnessMessages(), store.deliveredMessages());
    const streamed = [];
    for await (const entry of walkSessionTranscript(store, store.activeHeadId(), store.appendedLineCount())) streamed.push(entry);
    expect(streamed).toEqual([...full]);
    const original = store.walkMessageAncestors.bind(store);
    let reads = 0;
    store.walkMessageAncestors = async function* (id) {
        for await (const entry of original(id)) { reads += 1; yield entry; }
    };
    for (const id of ["replacement", "entry-559", "entry-480", "entry-321", "entry-1"]) {
        reads = 0;
        const cursor = `${id}#0`;
        const last = full.findLastIndex((entry) => entry.id?.startsWith(`${id}#`));
        let end = last + 1;
        while (end < full.length && full[end]!.id?.startsWith("harness:")) end += 1;
        const expected = historyPageFromEntries(full.slice(0, end), cursor, { headId: "replacement" });
        expect(await historyPageFromStore(store, cursor)).toEqual(expected);
        if (id === "replacement") expect(reads).toBeLessThan(500);
    }
    const abandoned = await historyPageFromStore(store, "entry-599#0");
    const rewindAt = records.findIndex((record) => Reflect.get(record, "type") === "rewind");
    const abandonedPath = join(directory, "abandoned.jsonl");
    await Bun.write(abandonedPath, `${records.slice(0, rewindAt).map((record) => JSON.stringify(record)).join("\n")}\n`);
    const abandonedStore = await SessionStore.open(abandonedPath);
    const abandonedFull = projectTranscript(abandonedStore.messages(), undefined, abandonedStore.activeMessageStamps(),
        abandonedStore.projectedHarnessMessages(), abandonedStore.deliveredMessages());
    expect(abandoned).toEqual(historyPageFromEntries(abandonedFull, "entry-599#0", { headId: "replacement" }));
    if (abandoned.kind === "page") {
        expect(abandoned.page.headId).toBe("replacement");
        expect(abandoned.entries.some((entry) => entry.id === "entry-598#0")).toBe(true);
    }
});

test("indexed pages preserve turn grouping at the byte limit", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "byte-pages.jsonl");
    const created = await SessionStore.create(path, { sessionId: "bytes", cwd: directory });
    const timestamp = "2026-11-04T12:00:00.000Z";
    const records: object[] = [created.header];
    for (let number = 0; number < 420; number += 1) {
        const message: ModelMessage = number % 53 === 0 ? userMessage(`turn ${number}`)
            : number % 13 === 0 ? { role: "user", internal: true, content: [{ type: "text", text: "internal" }] }
            : { role: "assistant", source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop", content: [
                { type: "thinking", text: `reason ${number}`, signature: "opaque" },
                { type: "text", text: "x".repeat((number % 7 + 1) * 3000) },
            ] };
        records.push({ type: "message", id: `entry-${number}`, parentId: number === 0 ? null : `entry-${number - 1}`, timestamp, message });
        if (number % 37 === 0) records.push({ type: "harness_message", timestamp, afterMessageId: `entry-${number}`, text: `notice ${number}`, tone: "soft" });
    }
    await Bun.write(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const store = await SessionStore.open(path);
    const full = projectTranscript(store.messages(), undefined, store.activeMessageStamps(), store.projectedHarnessMessages());
    for (const number of [419, 398, 370, 301, 250, 190, 107, 54, 1]) {
        const id = `entry-${number}`;
        const cursor = `${id}#0`;
        const last = full.findLastIndex((entry) => entry.id?.startsWith(`${id}#`));
        let end = last + 1;
        while (end < full.length && full[end]!.id?.startsWith("harness:")) end += 1;
        const expected = historyPageFromEntries(full.slice(0, end), cursor, { headId: "entry-419" });
        expect(await historyPageFromStore(store, cursor)).toEqual(expected);
    }
});

test("indexed pages render attachment names and deliveries from disk", async () => {
    const directory = temporaryDirectory();
    const store = await SessionStore.create(join(directory, "decorations.jsonl"), {
        sessionId: "decorations", cwd: directory, createId: scripted("user", "delivered", "reply", "cursor"),
    });
    const sha256 = "a".repeat(64);
    const attachmentId = `${sha256}.png`;
    await store.appendAttachment({ id: attachmentId, name: "map.png", mediaType: "image/png", bytes: 123, width: 10, height: 20, sha256 });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "look" }, { type: "image_attachment", attachmentId }] });
    await store.recordDelivery({ id: "delivery", sourceAgentId: "source", content: "report" });
    await store.appendDeliveryMessage("delivery", { role: "user", internal: true, content: [{ type: "text", text: "report" }] });
    await store.appendMessage(assistantMessage("done"));
    await store.appendMessage(userMessage("next"));
    const reopened = await SessionStore.open(store.path);
    const full = projectTranscript(reopened.messages(), (id) => id === attachmentId ? "map.png" : undefined,
        reopened.activeMessageStamps(), reopened.projectedHarnessMessages(), reopened.deliveredMessages());
    const streamed = [];
    for await (const entry of walkSessionTranscript(reopened, reopened.activeHeadId(), reopened.appendedLineCount())) streamed.push(entry);
    expect(streamed).toEqual([...full]);
    const expected = historyPageFromEntries(full, "cursor#0", { headId: "cursor" });
    expect(await historyPageFromStore(reopened, "cursor#0")).toEqual(expected);
    const limit = reopened.appendedLineCount();
    await reopened.appendHarnessMessage("later", "soft");
    const snapshot = [];
    for await (const entry of walkSessionTranscript(reopened, "cursor", limit)) snapshot.push(entry);
    expect(snapshot).toEqual([...full]);
});
