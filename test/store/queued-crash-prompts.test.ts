import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CRASH_CUT_MESSAGE,
    CRASH_QUEUED_PROMPT_MESSAGE,
    CRASH_QUEUED_PROMPTS_MESSAGE,
    readSessionTurnState,
    SessionStore,
} from "../../src/store/session-store.ts";
import { emptyUsage } from "../../src/model/types.ts";

test("starting a queued turn records and consumes the prompt in one append", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-start-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendQueuedPrompt("next", { content: "check the sails" });
        await store.appendMessage(
            { role: "user", content: [{ type: "text", text: "check the sails" }] },
            { turnStart: true, queuedPromptId: "next" },
        );
        const records = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
        expect(records.at(-1)).toMatchObject({ type: "turn_start", queuedPromptId: "next" });
        const reopened = await SessionStore.open(path);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(await reopened.repairCrashedTurn()).toBe(true);
        expect((await SessionStore.open(path)).unsentPrompts()).toEqual([{ content: "check the sails" }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("queued prompts join atomically, can be removed, and survive a crash in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-store-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] }, { turnStart: true });
        await store.appendQueuedPrompt("joined", { content: "joined" });
        await store.appendQueuedPrompt("removed", { content: "removed" });
        await store.appendQueuedPrompt("held", { content: "held" });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "joined" }], arrivedDuringTurn: true }, { queuedPromptId: "joined" });
        await store.removeQueuedPrompt("removed");
        expect((await SessionStore.open(path)).queuedPrompts().map((entry) => entry.content)).toEqual(["held"]);
        expect(await store.repairCrashedTurn()).toBe(true);
        expect(store.unsentPrompts()).toEqual([{ content: "first" }, { content: "joined" }, { content: "held" }]);
        const repaired = await readFile(path, "utf8");
        expect(repaired.split(CRASH_CUT_MESSAGE)).toHaveLength(2);
        expect(repaired).not.toContain(CRASH_QUEUED_PROMPTS_MESSAGE);
        const reopened = await SessionStore.open(path);
        expect(reopened.unsentPrompts()).toEqual(store.unsentPrompts());
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(await reopened.repairCrashedTurn()).toBe(false);
        expect(await readFile(path, "utf8")).toBe(repaired);
        await reopened.appendMessage({ role: "user", internal: true, content: [{ type: "text", text: "session context" }] });
        expect(reopened.unsentPrompts()).toEqual(store.unsentPrompts());
        expect(await reopened.repairCrashedTurn()).toBe(false);
        await reopened.appendMessage({ role: "user", content: [{ type: "text", text: "next" }] }, { turnStart: true });
        expect(reopened.unsentPrompts()).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("repair keeps attachments and does not re-offer a prompt that received an assistant reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-image-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        const sha256 = "a".repeat(64);
        const id = `${sha256}.png`;
        await store.appendAttachment({ id, name: "crow.png", mediaType: "image/png", bytes: 123, width: 10, height: 20, sha256 });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }] }, { turnStart: true });
        await store.appendMessage({
            role: "assistant", content: [{ type: "tool_call", id: "call", name: "read", input: {} }],
            source: { provider: "stub", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
        });
        await store.appendQueuedPrompt("image", { content: "look", attachmentIds: [id] });
        expect(await store.repairCrashedTurn()).toBe(true);
        expect((await SessionStore.open(path)).unsentPrompts()).toEqual([{ content: "look", attachmentIds: [id] }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const count of [1, 2]) {
    test(`${count} queued ${count === 1 ? "prompt survives" : "prompts survive"} a crash after a completed reply`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-queue-between-turns-"));
        const path = join(root, "crow.jsonl");
        try {
            const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
            await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }] }, { turnStart: true });
            await store.appendMessage({
                role: "assistant", content: [{ type: "tool_call", id: "read-1", name: "read", input: {} }],
                source: { provider: "stub", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
            });
            await store.appendMessage({
                role: "tool_result", toolCallId: "read-1", toolName: "read",
                content: [{ type: "text", text: "clear" }], isError: false,
            });
            for (let index = 0; index < count; index += 1) {
                await store.appendQueuedPrompt(`held-${index}`, { content: `check sails ${index}` });
            }
            const reply = await store.appendMessage({
                role: "assistant", content: [{ type: "text", text: "clear" }],
                source: { provider: "stub", api: "scripted", model: "test" }, usage: emptyUsage(),
                stopReason: "stop", turnTiming: { durationMs: 1, finishedAt: 1 },
            });
            await store.appendMessage({ role: "user", internal: true, content: [{ type: "text", text: "context" }] });
            const beforeMessages = store.messages();
            expect(await readSessionTurnState(path)).toMatchObject({ turnOpen: false, needsQueueRecovery: true });
            expect(await store.repairCrashedTurn()).toBe(true);
            expect(store.messages()).toEqual(beforeMessages);
            const expected = Array.from({ length: count }, (_, index) => ({ content: `check sails ${index}` }));
            const message = count === 1 ? CRASH_QUEUED_PROMPT_MESSAGE : CRASH_QUEUED_PROMPTS_MESSAGE;
            expect(store.projectedHarnessMessages()).toEqual([{ afterMessage: 4, id: "harness:0", text: message, tone: "soft" }]);
            const repaired = await readFile(path, "utf8");
            const record = JSON.parse(repaired.trimEnd().split("\n").at(-1)!);
            expect(record).toMatchObject({
                type: "harness_message", afterMessageId: reply.id, text: message, tone: "soft", unsentPrompts: expected,
            });
            expect(record.crashCut).toBeUndefined();
            expect(repaired).not.toContain(CRASH_CUT_MESSAGE);
            const reopened = await SessionStore.open(path);
            expect(reopened.queuedPrompts()).toEqual([]);
            expect(reopened.unsentPrompts()).toEqual(expected);
            expect(await reopened.repairCrashedTurn()).toBe(false);
            expect(await readFile(path, "utf8")).toBe(repaired);
            await reopened.appendMessage({ role: "user", content: [{ type: "text", text: "reference" }] });
            expect(reopened.unsentPrompts()).toEqual(expected);
            await reopened.appendMessage({
                role: "user", ...(count === 2 ? { internal: true } : {}),
                content: [{ type: "text", text: "next" }],
            }, { turnStart: true });
            expect(reopened.unsentPrompts()).toEqual([]);
            expect((await SessionStore.open(path)).unsentPrompts()).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("an unanswered cut prompt retains its image attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-cut-image-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        const sha256 = "b".repeat(64);
        const id = `${sha256}.png`;
        await store.appendAttachment({ id, name: "chart.png", mediaType: "image/png", bytes: 123, width: 10, height: 20, sha256 });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_attachment", attachmentId: id }] }, { turnStart: true });
        await store.repairCrashedTurn();
        expect((await SessionStore.open(path)).unsentPrompts()).toEqual([{ content: "inspect", attachmentIds: [id] }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
