import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage } from "../../src/model/types.ts";

test("queued prompts join atomically, can be removed, and survive a crash in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-store-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] });
        await store.appendQueuedPrompt("joined", { content: "joined" });
        await store.appendQueuedPrompt("removed", { content: "removed" });
        await store.appendQueuedPrompt("held", { content: "held" });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "joined" }], arrivedDuringTurn: true }, "joined");
        await store.removeQueuedPrompt("removed");
        expect((await SessionStore.open(path)).queuedPrompts().map((entry) => entry.content)).toEqual(["held"]);
        expect(await store.repairCrashedTurn()).toBe(true);
        expect(store.unsentPrompts()).toEqual([{ content: "first" }, { content: "joined" }, { content: "held" }]);
        const repaired = await readFile(path, "utf8");
        const reopened = await SessionStore.open(path);
        expect(reopened.unsentPrompts()).toEqual(store.unsentPrompts());
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(await reopened.repairCrashedTurn()).toBe(false);
        expect(await readFile(path, "utf8")).toBe(repaired);
        await reopened.appendMessage({ role: "user", internal: true, content: [{ type: "text", text: "session context" }] });
        expect(reopened.unsentPrompts()).toEqual(store.unsentPrompts());
        expect(await reopened.repairCrashedTurn()).toBe(false);
        await reopened.appendMessage({ role: "user", content: [{ type: "text", text: "next" }] });
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
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }] });
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

test("a queued prompt survives a crash after the preceding reply was saved", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-between-turns-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }] });
        await store.appendQueuedPrompt("held", { content: "check sails" });
        await store.appendMessage({
            role: "assistant", content: [{ type: "text", text: "clear" }],
            source: { provider: "stub", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "stop",
        });
        expect(await store.repairCrashedTurn()).toBe(true);
        expect((await SessionStore.open(path)).unsentPrompts()).toEqual([{ content: "check sails" }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an unanswered cut prompt retains its image attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-cut-image-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        const sha256 = "b".repeat(64);
        const id = `${sha256}.png`;
        await store.appendAttachment({ id, name: "chart.png", mediaType: "image/png", bytes: 123, width: 10, height: 20, sha256 });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_attachment", attachmentId: id }] });
        await store.repairCrashedTurn();
        expect((await SessionStore.open(path)).unsentPrompts()).toEqual([{ content: "inspect", attachmentIds: [id] }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
