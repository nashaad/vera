import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { turnFinishedPayload } from "../../src/host/agent-registry/turn-finished.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string, stopReason: "stop" | "tool_use" = "stop"): ModelMessage {
    return {
        role: "assistant", content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(), stopReason,
    };
}

test("@core turn hooks keep a prompt across compaction and rewind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-turn-finished-"));
    try {
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, { sessionId: "ship", cwd: directory });
        await store.appendMessage(user("first"));
        await store.appendMessage(assistant("first answer"));
        const abandoned = await store.appendMessage(user("abandoned"));
        await store.appendMessage(assistant("abandoned answer"));
        await store.rewindBefore(abandoned.id);
        const prompt = "sail ".repeat(30_000);
        const current = await store.appendMessage(user(prompt));
        await store.appendCompaction({ boundaryMessageId: current.id, firstRetainedMessageId: null,
            projection: [assistant("summary")], measured: { inputTokens: 5, estimated: true } });
        await store.appendMessage({ role: "user", arrivedDuringTurn: true, content: [{ type: "text", text: "and return" }] });
        await store.appendMessage(assistant("done"));
        const update = { type: "turn_finished" as const, seq: 1 };
        for (const subject of [store, await SessionStore.open(path)]) {
            expect(subject.turnCount()).toBe(2);
            expect(turnFinishedPayload(subject, update)).toMatchObject({
                turns: 2, prompt: `${prompt.trim()}\n\nand return`, reply: "done",
            });
        }
        const third = await store.appendMessage(user("third"));
        expect(store.turnCount()).toBe(3);
        await store.rewindBefore(third.id);
        expect(store.turnCount()).toBe(2);
        expect((await SessionStore.open(path)).turnCount()).toBe(2);
        expect(turnFinishedPayload(store, update).prompt).toBe(`${prompt.trim()}\n\nand return`);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("two compactions accumulate only the last turn's text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-turn-compactions-"));
    try {
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: directory });
        const prompt = await store.appendMessage(user("find the map"));
        await store.appendCompaction({ boundaryMessageId: prompt.id, firstRetainedMessageId: null,
            projection: [assistant("summary")], measured: { inputTokens: 5, estimated: true } });
        const progress = await store.appendMessage(assistant("checking", "tool_use"));
        const extra = await store.appendMessage({ role: "user", arrivedDuringTurn: true, content: [{ type: "text", text: "and the key" }] });
        await store.appendCompaction({ boundaryMessageId: progress.id, firstRetainedMessageId: extra.id,
            projection: [assistant("summary two")], measured: { inputTokens: 5, estimated: true } });
        await store.appendMessage(assistant("found both"));
        const update = { type: "turn_finished" as const, seq: 1 };
        for (const subject of [store, await SessionStore.open(path)]) {
            expect(subject.carriedTurnText()).toEqual({ prompt: ["find the map"], reply: ["checking"] });
            expect(turnFinishedPayload(subject, update)).toMatchObject({ prompt: "find the map\n\nand the key", reply: "checking\n\nfound both" });
        }
        await store.appendCompaction({ boundaryMessageId: prompt.id, firstRetainedMessageId: progress.id,
            projection: [assistant("earlier boundary")], measured: { inputTokens: 5, estimated: true } });
        for (const subject of [store, await SessionStore.open(path)]) {
            expect(subject.carriedTurnText()).toEqual({ prompt: ["find the map"], reply: [] });
            expect(turnFinishedPayload(subject, update)).toMatchObject({ prompt: "find the map\n\nand the key", reply: "checking\n\nfound both" });
        }
        await store.appendMessage(user("next voyage"));
        expect(store.carriedTurnText()).toBeUndefined();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("foreign compactions preserve the current turn and a new delivery releases it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-turn-foreign-"));
    try {
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: directory });
        const prompt = await store.appendMessage(user("find the map"));
        await store.appendForeignRecord({ type: "compaction", id: "first-compaction", timestamp: new Date().toISOString(),
            boundaryMessageId: prompt.id, firstRetainedMessageId: null,
            projection: [assistant("summary")], measured: { inputTokens: 5, estimated: true } });
        const progress = await store.appendMessage(assistant("checking", "tool_use"));
        await store.appendForeignRecord({ type: "compaction", id: "second-compaction", timestamp: new Date().toISOString(),
            boundaryMessageId: progress.id, firstRetainedMessageId: null,
            projection: [assistant("summary two")], measured: { inputTokens: 5, estimated: true } });
        for (const subject of [store, await SessionStore.open(path)]) {
            expect(subject.carriedTurnText()).toEqual({ prompt: ["find the map"], reply: ["checking"] });
        }
        await store.appendForeignRecord({ type: "compaction", id: "earlier-compaction", timestamp: new Date().toISOString(),
            boundaryMessageId: prompt.id, firstRetainedMessageId: progress.id,
            projection: [assistant("earlier summary")], measured: { inputTokens: 5, estimated: true } });
        for (const subject of [store, await SessionStore.open(path)]) {
            expect(subject.carriedTurnText()).toEqual({ prompt: ["find the map"], reply: [] });
        }
        await store.recordDelivery({ id: "delivery", sourceAgentId: "mate", content: "map found" });
        await store.appendDeliveryMessage("delivery", { role: "user", internal: true, content: [{ type: "text", text: "map found" }] });
        expect(store.carriedTurnText()).toBeUndefined();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("@core a compacted delivery turn keeps its reply and has an empty prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-turn-delivery-"));
    try {
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: directory });
        await store.appendMessage(user("earlier"));
        await store.appendMessage(assistant("earlier reply"));
        await store.recordDelivery({ id: "delivery", sourceAgentId: "mate", content: "map found" });
        const delivery = await store.appendDeliveryMessage("delivery", {
            role: "user", internal: true, content: [{ type: "text", text: "map found" }],
        });
        await store.appendCompaction({ boundaryMessageId: delivery.id, firstRetainedMessageId: null,
            projection: [assistant("summary")], measured: { inputTokens: 5, estimated: true } });
        await store.appendMessage(assistant("course set"));
        const update = { type: "turn_finished" as const, seq: 1 };
        for (const subject of [store, await SessionStore.open(path)]) {
            expect(subject.carriedTurnText()).toEqual({ prompt: [], reply: [] });
            expect(turnFinishedPayload(subject, update)).toMatchObject({ prompt: "", reply: "course set" });
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("carried text excludes internal, hook, thinking and tool content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-turn-filter-"));
    try {
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: directory });
        await store.appendMessage(user("find the map"));
        await store.appendMessage({ role: "assistant", source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(), stopReason: "tool_use", content: [
                { type: "thinking", text: "private thought" }, { type: "text", text: "checking" },
                { type: "tool_call", id: "call", name: "read", input: {} },
            ] });
        await store.appendMessage({ role: "tool_result", toolCallId: "call", toolName: "read", isError: false,
            content: [{ type: "text", text: "tool output" }] });
        await store.appendMessage({ role: "user", internal: true, content: [{ type: "text", text: "internal" }] });
        const hook = await store.appendMessage({ role: "user", internal: true, contextSource: "pre_turn", content: [{ type: "text", text: "hook context" }] });
        await store.appendCompaction({ boundaryMessageId: hook.id, firstRetainedMessageId: null,
            projection: [assistant("summary")], measured: { inputTokens: 5, estimated: true } });
        const update = { type: "turn_finished" as const, seq: 1 };
        for (const subject of [store, await SessionStore.open(path)]) {
            expect(subject.carriedTurnText()).toEqual({ prompt: ["find the map"], reply: ["checking"] });
            expect(turnFinishedPayload(subject, update)).toMatchObject({ prompt: "find the map", reply: "checking" });
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("turn hook counts follow the active branch across compaction and rewind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-turn-count-"));
    try {
        const path = join(directory, "session.jsonl");
        const store = await SessionStore.create(path, { sessionId: "ship", cwd: directory });
        await store.appendMessage(user("first"));
        const answer = await store.appendMessage(assistant("first answer"));
        const abandoned = await store.appendMessage(user("abandoned"));
        await store.appendMessage(assistant("abandoned answer"));
        await store.rewindBefore(abandoned.id);
        const current = await store.appendMessage(user("current"));
        await store.appendCompaction({ boundaryMessageId: answer.id, firstRetainedMessageId: current.id,
            projection: [assistant("summary")], measured: { inputTokens: 5, estimated: true } });
        const update = { type: "turn_finished" as const, seq: 1 };
        expect(turnFinishedPayload(store, update).turns).toBe(2);
        expect(turnFinishedPayload(await SessionStore.open(path), update).turns).toBe(2);
        const third = await store.appendMessage(user("third"));
        expect(store.turnCount()).toBe(3);
        await store.rewindBefore(third.id);
        expect(turnFinishedPayload(store, update).turns).toBe(2);
        expect((await SessionStore.open(path)).turnCount()).toBe(2);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
