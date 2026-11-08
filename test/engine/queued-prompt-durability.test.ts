import { expect, test } from "bun:test";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../src/store/session-store.ts";

test("queue admission and withdrawal are published after their durable writes", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe((event) => observed.push(event));
    let releaseAppend!: () => void;
    let releaseRemoval!: () => void;
    const append = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const removal = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    const writes: string[] = [];
    const router = new InboundCommandRouter(channel.engine, events, {
        async appendQueuedPrompt(_id, prompt) { await append; writes.push(`add:${prompt.content}`); },
        async removeQueuedPrompt() { await removal; writes.push("remove"); },
    });
    const first = router.startTurn();
    channel.client.send({ type: "prompt", content: "active" });
    await first;
    channel.client.send({ type: "prompt", content: "held", requestId: "request-1" });
    await Bun.sleep(5);
    expect(observed.some((event) => event.type === "prompt_queue_changed" || event.type === "prompt_admission")).toBe(false);
    releaseAppend();
    await Bun.sleep(5);
    expect(writes).toEqual(["add:held"]);
    expect(observed).toContainEqual({ type: "prompt_admission", requestId: "request-1", content: "held", status: "accepted" });
    channel.client.send({ type: "withdraw_queued_prompt", requestId: "withdraw-1" });
    await Bun.sleep(5);
    expect(observed.some((event) => event.type === "prompt_withdrawn")).toBe(false);
    releaseRemoval();
    await Bun.sleep(5);
    expect(writes).toEqual(["add:held", "remove"]);
    expect(observed).toContainEqual({ type: "prompt_withdrawn", requestId: "withdraw-1", content: "held" });
    router.finishTurn();
});

test("a clean halt durably discards prompts it drops", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-halt-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        const channel = createInProcessChannel();
        const router = new InboundCommandRouter(channel.engine, new EngineEventBus(), {
            appendQueuedPrompt: (id, prompt) => store.appendQueuedPrompt(id, { content: prompt.content }),
            removeQueuedPrompt: (id) => store.removeQueuedPrompt(id),
        });
        const first = router.startTurn();
        channel.client.send({ type: "prompt", content: "active" });
        await first;
        channel.client.send({ type: "prompt", content: "held" });
        while (store.queuedPrompts().length === 0) await Bun.sleep(5);
        router.halt("stopped");
        await router.discardQueuedPrompts();
        expect((await SessionStore.open(path)).queuedPrompts()).toEqual([]);
        router.finishTurn();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("shutdown waits for an in-flight queue write before discarding it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-queue-shutdown-"));
    const path = join(root, "crow.jsonl");
    try {
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        const channel = createInProcessChannel();
        let releaseWrite!: () => void;
        let writing!: () => void;
        const ready = new Promise<void>((resolve) => { writing = resolve; });
        const writeAllowed = new Promise<void>((resolve) => { releaseWrite = resolve; });
        const router = new InboundCommandRouter(channel.engine, new EngineEventBus(), {
            async appendQueuedPrompt(id, prompt) {
                writing();
                await writeAllowed;
                await store.appendQueuedPrompt(id, { content: prompt.content });
            },
            removeQueuedPrompt: (id) => store.removeQueuedPrompt(id),
        });
        const first = router.startTurn();
        channel.client.send({ type: "prompt", content: "active" });
        await first;
        channel.client.send({ type: "prompt", content: "held" });
        await ready;
        let stopped = false;
        const stopping = router.stopReceivingCommands().then(() => { stopped = true; });
        await Bun.sleep(5);
        expect(stopped).toBe(false);
        releaseWrite();
        await stopping;
        await router.discardQueuedPrompts();
        expect((await SessionStore.open(path)).queuedPrompts()).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed queue write rejects the prompt without acknowledging it", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe((event) => observed.push(event));
    const router = new InboundCommandRouter(channel.engine, events, {
        async appendQueuedPrompt() { throw new Error("disk full"); },
    });
    const first = router.startTurn();
    channel.client.send({ type: "prompt", content: "active" });
    await first;
    channel.client.send({ type: "prompt", content: "held", requestId: "request-2" });
    await Bun.sleep(5);
    expect(observed).toContainEqual({
        type: "prompt_admission", requestId: "request-2", content: "held",
        status: "rejected", reason: "Could not save the queued prompt.",
    });
    expect(observed.some((event) => event.type === "prompt_queued")).toBe(false);
    router.finishTurn();
});

test("a failed withdrawal keeps the prompt queued and allows another attempt", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];
    events.subscribe((event) => observed.push(event));
    let attempts = 0;
    const router = new InboundCommandRouter(channel.engine, events, {
        async appendQueuedPrompt() {},
        async removeQueuedPrompt() { if (++attempts === 1) throw new Error("disk full"); },
    });
    const first = router.startTurn();
    channel.client.send({ type: "prompt", content: "active" });
    await first;
    channel.client.send({ type: "prompt", content: "held" });
    await Bun.sleep(5);
    channel.client.send({ type: "withdraw_queued_prompt", requestId: "first" });
    await Bun.sleep(5);
    expect(observed).toContainEqual({ type: "notice", key: "queue_withdraw_failed", count: 1, text: "Could not recall the queued prompt." });
    channel.client.send({ type: "withdraw_queued_prompt", requestId: "second" });
    await Bun.sleep(5);
    expect(observed).toContainEqual({ type: "prompt_withdrawn", requestId: "second", content: "held" });
    router.finishTurn();
});
