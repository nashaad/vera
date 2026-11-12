import { expect, test } from "bun:test";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    AttachmentQueueOverflowError,
    AttachmentUpdateQueue,
} from "../../src/host/attachment-update-queue.ts";
import {
    REASONING_PROGRESS_INTERVAL_MS,
    ReasoningProgressCoalescer,
} from "../../src/host/reasoning-progress.ts";
import { AgentDetachedError, ResidentAgent } from "../../src/host/resident-agent.ts";

const FAST = { reasoningProgress: { intervalMs: 15 } } as const;

function thought(text: string, seq: number): AgentUpdate {
    return { type: "assistant_thinking", text, seq };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain(queue: { receive(): Promise<AgentUpdate> }, count: number): Promise<AgentUpdate[]> {
    const received: AgentUpdate[] = [];
    for (let index = 0; index < count; index += 1) received.push(await queue.receive());
    return received;
}

function progressTotal(updates: readonly AgentUpdate[]): number {
    let total = 0;
    for (const update of updates) {
        if (update.type === "assistant_thinking_progress") total += update.characters;
    }
    return total;
}

test("the default interval is 250 ms", () => {
    expect(REASONING_PROGRESS_INTERVAL_MS).toBe(250);
});

test("@core an attachment that did not negotiate gets every reasoning delta unchanged", async () => {
    const queue = new AttachmentUpdateQueue();
    queue.push(thought("a", 1));
    queue.push(thought("bc", 2));
    queue.push({ type: "assistant_delta", text: "x", seq: 3 });
    expect(await drain(queue, 3)).toEqual([
        thought("a", 1),
        thought("bc", 2),
        { type: "assistant_delta", text: "x", seq: 3 },
    ]);
});

test("@core reasoning progress sums to the streamed length and carries the last covered seq", async () => {
    const queue = new AttachmentUpdateQueue({}, { reasoningProgress: true });
    let streamed = 0;
    for (let seq = 1; seq <= 200; seq += 1) {
        const text = "t".repeat((seq % 7) + 1);
        streamed += text.length;
        queue.push(thought(text, seq));
    }
    queue.push({ type: "assistant_delta", text: "answer", seq: 201 });
    const received = await drain(queue, 2);
    expect(received[0]).toEqual({ type: "assistant_thinking_progress", characters: streamed, seq: 200 });
    expect(received[1]).toEqual({ type: "assistant_delta", text: "answer", seq: 201 });
    expect(received.some((update) => update.type === "assistant_thinking")).toBe(false);
});

test("@core pending progress is sent before a following delta, tool update or turn end", async () => {
    const queue = new AttachmentUpdateQueue({}, { reasoningProgress: true });
    queue.push(thought("abc", 1));
    queue.push({ type: "assistant_delta", text: "x", seq: 2 });
    queue.push(thought("de", 3));
    queue.push({ type: "tool_started", tool: "read", args: {}, seq: 4 });
    queue.push(thought("f", 5));
    queue.push({ type: "turn_finished", seq: 6 });
    expect(await drain(queue, 6)).toEqual([
        { type: "assistant_thinking_progress", characters: 3, seq: 1 },
        { type: "assistant_delta", text: "x", seq: 2 },
        { type: "assistant_thinking_progress", characters: 2, seq: 3 },
        { type: "tool_started", tool: "read", args: {}, seq: 4 },
        { type: "assistant_thinking_progress", characters: 1, seq: 5 },
        { type: "turn_finished", seq: 6 },
    ]);
});

test("a delta with no text still advances the sequence the next update follows", async () => {
    const queue = new AttachmentUpdateQueue({}, { reasoningProgress: true });
    queue.push(thought("", 1));
    queue.push({ type: "assistant_delta", text: "x", seq: 2 });
    expect(await drain(queue, 2)).toEqual([
        { type: "assistant_thinking_progress", characters: 0, seq: 1 },
        { type: "assistant_delta", text: "x", seq: 2 },
    ]);
});

test("@core a burst of reasoning is one progress update per interval with nothing else following it", async () => {
    const queue = new AttachmentUpdateQueue({}, FAST);
    for (let seq = 1; seq <= 50; seq += 1) queue.push(thought("ab", seq));
    const first = await queue.receive();
    expect(first).toEqual({ type: "assistant_thinking_progress", characters: 100, seq: 50 });
    for (let seq = 51; seq <= 60; seq += 1) queue.push(thought("c", seq));
    const second = await queue.receive();
    expect(second).toEqual({ type: "assistant_thinking_progress", characters: 10, seq: 60 });
});

test("reasoning that streams for several intervals is reported in several updates", async () => {
    const queue = new AttachmentUpdateQueue({}, FAST);
    const updates: AgentUpdate[] = [];
    let seq = 0;
    const started = Date.now();
    while (Date.now() - started < 80) {
        seq += 1;
        queue.push(thought("x", seq));
        await delay(2);
    }
    queue.push({ type: "assistant_delta", text: "end", seq: seq + 1 });
    while (true) {
        const update = await queue.receive();
        updates.push(update);
        if (update.type === "assistant_delta") break;
    }
    const progress = updates.filter((update) => update.type === "assistant_thinking_progress");
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.length).toBeLessThan(seq);
    expect(progressTotal(updates)).toBe(seq);
    const seqs = progress.map((update) => update.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(seqs.at(-1)).toBe(seq);
});

test("replayed reasoning is not counted toward the client limits, live progress is", async () => {
    const queue = new AttachmentUpdateQueue({ maxUpdates: 2 }, { reasoningProgress: true });
    for (let seq = 1; seq <= 40; seq += 2) {
        queue.push(thought("a", seq), { counted: false });
        queue.push({ type: "assistant_delta", text: "b", seq: seq + 1 }, { counted: false });
    }
    queue.flushReasoning();
    expect(await queue.receive()).toMatchObject({ type: "assistant_thinking_progress", seq: 1 });

    const live = new AttachmentUpdateQueue({ maxUpdates: 2 }, { reasoningProgress: true });
    live.push(thought("a", 1));
    live.push({ type: "assistant_delta", text: "b", seq: 2 });
    live.push(thought("c", 3));
    live.push({ type: "assistant_delta", text: "d", seq: 4 });
    await expect(live.receive()).rejects.toBeInstanceOf(AttachmentQueueOverflowError);
});

test("@core a queue failed with its buffer discarded sends nothing later", async () => {
    const queue = new AttachmentUpdateQueue({}, FAST);
    queue.push(thought("abc", 1));
    queue.fail(new AgentDetachedError(), { discardBuffered: true });
    await delay(60);
    queue.push(thought("late", 2));
    queue.flushReasoning();
    await expect(queue.receive()).rejects.toBeInstanceOf(AgentDetachedError);
});

test("a queue failed without discarding delivers its pending count before the error", async () => {
    const queue = new AttachmentUpdateQueue({}, FAST);
    queue.push(thought("abcd", 7));
    const failure = new Error("closed");
    queue.fail(failure);
    expect(await queue.receive()).toEqual({ type: "assistant_thinking_progress", characters: 4, seq: 7 });
    await expect(queue.receive()).rejects.toBe(failure);
});

test("@core the coalescer holds no timer once flushed or disposed", async () => {
    const emitted: Array<[number, number, boolean]> = [];
    const coalescer = new ReasoningProgressCoalescer(
        (characters, seq, counted) => emitted.push([characters, seq, counted]),
        { intervalMs: 10 },
    );
    coalescer.add(3, 1, true);
    coalescer.flush();
    await delay(40);
    expect(emitted).toEqual([[3, 1, true]]);

    coalescer.add(5, 2, true);
    coalescer.dispose();
    coalescer.add(5, 3, true);
    coalescer.flush();
    await delay(40);
    expect(emitted).toEqual([[3, 1, true]]);
});

function trackTimers(): { outstanding(): number; restore(): void } {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const live = new Set<unknown>();
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
        const handle = realSet(() => {
            live.delete(handle);
            callback();
        }, ms);
        live.add(handle);
        return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
        live.delete(handle);
        realClear(handle);
    }) as typeof clearTimeout;
    return {
        outstanding: () => live.size,
        restore: () => {
            globalThis.setTimeout = realSet;
            globalThis.clearTimeout = realClear;
        },
    };
}

test("@core a timer exists only while a count is pending and every exit clears it", async () => {
    const timers = trackTimers();
    try {
        const idle = new AttachmentUpdateQueue({}, FAST);
        expect(timers.outstanding()).toBe(0);

        idle.push(thought("a", 1));
        expect(timers.outstanding()).toBe(1);
        idle.push(thought("b", 2));
        expect(timers.outstanding()).toBe(1);
        idle.push({ type: "assistant_delta", text: "x", seq: 3 });
        expect(timers.outstanding()).toBe(0);

        const detached = new AttachmentUpdateQueue({}, FAST);
        detached.push(thought("a", 1));
        detached.fail(new AgentDetachedError(), { discardBuffered: true });
        expect(timers.outstanding()).toBe(0);

        const closed = new AttachmentUpdateQueue({}, FAST);
        closed.push(thought("a", 1));
        closed.fail(new Error("closed"));
        expect(timers.outstanding()).toBe(0);

        const overflowing = new AttachmentUpdateQueue({ maxUpdates: 1 }, FAST);
        overflowing.push({ type: "assistant_delta", text: "x", seq: 1 });
        overflowing.push(thought("a", 2));
        overflowing.push({ type: "assistant_delta", text: "y", seq: 3 });
        expect(timers.outstanding()).toBe(0);

        const agent = new ResidentAgent("agent-1", "/work/one");
        const hidden = agent.attach(undefined, undefined, { reasoningProgress: { intervalMs: 10 } });
        agent.engine.send(thought("abc", 1));
        expect(timers.outstanding()).toBeGreaterThan(0);
        hidden.detach();
        expect(timers.outstanding()).toBe(0);
        agent.attach(undefined, undefined, { reasoningProgress: { intervalMs: 10 } });
        agent.engine.send(thought("def", 2));
        expect(timers.outstanding()).toBeGreaterThan(0);
        agent.close();
        expect(timers.outstanding()).toBe(0);
    } finally {
        timers.restore();
    }
});

test("the coalescer reports no counts when nothing is pending", async () => {
    const emitted: unknown[] = [];
    const coalescer = new ReasoningProgressCoalescer((...args) => emitted.push(args), { intervalMs: 10 });
    coalescer.flush();
    await delay(30);
    expect(emitted).toEqual([]);
});

test("@core two attachments on one agent each get their own form of the same reasoning", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const plain = agent.attach();
    const hidden = agent.attach(undefined, undefined, { reasoningProgress: true });
    try {
        agent.engine.send({ type: "status", state: "working", seq: 1 });
        agent.engine.send(thought("secret ", 2));
        agent.engine.send(thought("plan", 3));
        agent.engine.send({ type: "assistant_delta", text: "done", seq: 4 });
        agent.engine.send({
            type: "history",
            entries: [{ kind: "reasoning", text: "secret plan" }, { kind: "assistant", text: "done" }],
            seq: 4,
        });

        const plainUpdates = await drain(plain, 6);
        expect(plainUpdates.map((update) => update.type)).toEqual([
            "history", "status", "assistant_thinking", "assistant_thinking", "assistant_delta", "history",
        ]);

        const hiddenUpdates = await drain(hidden, 5);
        expect(hiddenUpdates.map((update) => update.type)).toEqual([
            "history", "status", "assistant_thinking_progress", "assistant_delta", "history",
        ]);
        expect(hiddenUpdates[2]).toEqual({ type: "assistant_thinking_progress", characters: 11, seq: 3 });
        expect(JSON.stringify(hiddenUpdates.slice(0, 4))).not.toContain("secret");
        expect(hiddenUpdates[4]).toEqual(plainUpdates[5]!);
        expect(hiddenUpdates[4]).toMatchObject({
            entries: [{ kind: "reasoning", text: "secret plan" }, { kind: "assistant", text: "done" }],
            seq: 4,
        });
    } finally {
        plain.detach();
        hidden.detach();
        agent.close();
    }
});

test("@core a history that follows reasoning keeps its sequence after the progress that covers it", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const hidden = agent.attach(undefined, undefined, { reasoningProgress: true });
    try {
        agent.engine.send(thought("abc", 1));
        agent.engine.send({ type: "history", entries: [{ kind: "reasoning", text: "abc" }], seq: 1 });
        const received = await drain(hidden, 3);
        expect(received[1]).toEqual({ type: "assistant_thinking_progress", characters: 3, seq: 1 });
        expect(received[2]).toMatchObject({ type: "history", seq: 1 });
    } finally {
        hidden.detach();
        agent.close();
    }
});

test("@core an attach replays earlier reasoning as progress through the same filter", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    agent.engine.send({ type: "status", state: "working", seq: 1 });
    agent.engine.send(thought("aa", 2));
    agent.engine.send(thought("bbb", 3));
    agent.engine.send({ type: "tool_started", tool: "read", args: {}, seq: 4 });
    agent.engine.send(thought("c", 5));
    const hidden = agent.attach(undefined, undefined, { reasoningProgress: true });
    try {
        const received = await drain(hidden, 5);
        expect(received.map((update) => update.type)).toEqual([
            "history", "status", "assistant_thinking_progress", "tool_started", "assistant_thinking_progress",
        ]);
        expect(received[2]).toEqual({ type: "assistant_thinking_progress", characters: 5, seq: 3 });
        expect(received[4]).toEqual({ type: "assistant_thinking_progress", characters: 1, seq: 5 });
        agent.engine.send({ type: "assistant_delta", text: "x", seq: 6 });
        expect(await hidden.receive()).toEqual({ type: "assistant_delta", text: "x", seq: 6 });
    } finally {
        hidden.detach();
        agent.close();
    }
});

test("@core resuming after a cursor inside a filtered span counts each character once", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    agent.engine.send({ type: "status", state: "working", seq: 1 });
    agent.engine.send(thought("aa", 2));
    agent.engine.send(thought("bbb", 3));
    agent.engine.send(thought("cccc", 4));
    agent.engine.send({ type: "assistant_delta", text: "x", seq: 5 });
    const resumedAfterStatus = agent.attach(1, undefined, { reasoningProgress: true });
    const resumedMidSpan = agent.attach(3, undefined, { reasoningProgress: true });
    const resumedAtEnd = agent.attach(4, undefined, { reasoningProgress: true });
    try {
        expect(await drain(resumedAfterStatus, 2)).toEqual([
            { type: "assistant_thinking_progress", characters: 9, seq: 4 },
            { type: "assistant_delta", text: "x", seq: 5 },
        ]);
        expect(await drain(resumedMidSpan, 2)).toEqual([
            { type: "assistant_thinking_progress", characters: 4, seq: 4 },
            { type: "assistant_delta", text: "x", seq: 5 },
        ]);
        expect(await drain(resumedAtEnd, 1)).toEqual([{ type: "assistant_delta", text: "x", seq: 5 }]);
    } finally {
        resumedAfterStatus.detach();
        resumedMidSpan.detach();
        resumedAtEnd.detach();
        agent.close();
    }
});

test("@core resuming at the seq of a delivered progress update counts only what came after it", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const first = agent.attach(undefined, undefined, { reasoningProgress: { intervalMs: 10 } });
    try {
        expect(await first.receive()).toMatchObject({ type: "history" });
        agent.engine.send(thought("aa", 1));
        agent.engine.send(thought("bbb", 2));
        const head = await first.receive();
        expect(head).toEqual({ type: "assistant_thinking_progress", characters: 5, seq: 2 });
        first.detach();

        agent.engine.send(thought("cccc", 3));
        agent.engine.send(thought("d", 4));
        agent.engine.send({ type: "assistant_delta", text: "x", seq: 5 });

        const resumed = agent.attach(2, undefined, { reasoningProgress: true });
        try {
            const tail = await drain(resumed, 2);
            expect(tail[0]).toEqual({ type: "assistant_thinking_progress", characters: 5, seq: 4 });
            expect(tail[1]).toEqual({ type: "assistant_delta", text: "x", seq: 5 });
        } finally {
            resumed.detach();
        }
    } finally {
        agent.close();
    }
});

test("@core detaching with reasoning pending sends nothing afterwards", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const hidden = agent.attach(undefined, undefined, { reasoningProgress: { intervalMs: 10 } });
    try {
        expect(await hidden.receive()).toMatchObject({ type: "history" });
        agent.engine.send(thought("abc", 1));
        hidden.detach();
        await delay(50);
        agent.engine.send(thought("def", 2));
        await delay(50);
        await expect(hidden.receive()).rejects.toBeInstanceOf(AgentDetachedError);
    } finally {
        agent.close();
    }
});

test("closing the agent with reasoning pending sends nothing afterwards", async () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    const hidden = agent.attach(undefined, undefined, { reasoningProgress: { intervalMs: 10 } });
    expect(await hidden.receive()).toMatchObject({ type: "history" });
    agent.engine.send(thought("abc", 1));
    agent.close();
    await delay(50);
    const outcome = await hidden.receive().then(
        (update) => update,
        (error: unknown) => error,
    );
    expect(outcome).not.toMatchObject({ type: "assistant_thinking" });
});

test("the engine cannot produce reasoning progress itself", () => {
    const agent = new ResidentAgent("agent-1", "/work/one");
    try {
        expect(() => agent.engine.send({ type: "assistant_thinking_progress", characters: 1, seq: 1 }))
            .toThrow("Reasoning progress is produced for one attachment");
    } finally {
        agent.close();
    }
});
