import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import * as indexScan from "../../src/store/session-index-scan.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];
afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function answer(text: string): ModelMessage {
    return { role: "assistant", content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop" };
}

test("@core foreign message appends on an indexed store match a fresh open without rescanning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-foreign-append-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const writer = await SessionStore.create(path, { sessionId: "foreign", cwd: directory });
    let boundary = "";
    let retained = "";
    for (let round = 0; round < 300; round += 1) {
        const asked = await writer.appendMessage(user(`question ${round} ${"x".repeat(400)}`), { turnStart: true });
        const answered = await writer.appendMessage(answer(`answer ${round}`));
        if (round === 200) boundary = answered.id;
        if (round === 201) retained = asked.id;
    }
    await writer.appendCompaction({ boundaryMessageId: boundary, firstRetainedMessageId: retained,
        projection: [answer("summary")], measured: { inputTokens: 10, estimated: true } });

    const store = await SessionStore.open(path);
    const scans = spyOn(indexScan, "scanSessionIndex");
    let head = store.activeHeadId();
    for (let round = 0; round < 40; round += 1) {
        for (const [type, message] of [["turn_start", user(`foreign ${round}`)], ["message", answer(`reply ${round}`)]] as const) {
            const id = `foreign-${type}-${round}`;
            await store.appendForeignRecord({ type, id, parentId: head, timestamp: new Date().toISOString(), message });
            head = id;
        }
    }
    expect(scans).toHaveBeenCalledTimes(0);
    scans.mockRestore();

    const reopened = await SessionStore.open(path);
    expect(store.activeHeadId()).toBe(reopened.activeHeadId());
    expect(store.modelContext()).toEqual(reopened.modelContext());
    expect(store.liveMessageEntries()).toEqual(reopened.liveMessageEntries());
    expect(store.unsentPrompts()).toEqual(reopened.unsentPrompts());
    expect(store.usageSummary()).toEqual(reopened.usageSummary());
    expect(store.appendedLineCount()).toBe(reopened.appendedLineCount());
});

test("a foreign rewind is checked against the indexed branch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-foreign-rewind-"));
    directories.push(directory);
    const path = join(directory, "session.jsonl");
    const writer = await SessionStore.create(path, { sessionId: "rewind", cwd: directory });
    const first = await writer.appendMessage(user("first"), { turnStart: true });
    const firstAnswer = await writer.appendMessage(answer("first answer"));
    const second = await writer.appendMessage(user("second"), { turnStart: true });
    await writer.appendMessage(answer("second answer"));
    const store = await SessionStore.open(path);
    const head = store.activeHeadId();
    const timestamp = new Date().toISOString();
    await expect(store.appendForeignRecord({ type: "rewind", timestamp, userMessageId: firstAnswer.id,
        previousHeadId: head, headId: first.id })).rejects.toThrow(/active user message/);
    await expect(store.appendForeignRecord({ type: "rewind", timestamp, userMessageId: second.id,
        previousHeadId: head, headId: first.id })).rejects.toThrow(/wrong rewind target/);
    const scans = spyOn(indexScan, "scanSessionIndex");
    await store.appendForeignRecord({ type: "rewind", timestamp, userMessageId: second.id,
        previousHeadId: head, headId: firstAnswer.id });
    expect(scans).toHaveBeenCalledTimes(1);
    scans.mockRestore();
    const reopened = await SessionStore.open(path);
    expect(store.activeHeadId()).toBe(firstAnswer.id);
    expect(store.modelContext()).toEqual(reopened.modelContext());
});
