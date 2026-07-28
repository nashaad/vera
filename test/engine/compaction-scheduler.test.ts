import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    COMPACTION_TRIGGER_FRACTION,
    compactSession,
    shouldCompact,
    type CompactionSchedulerOptions,
} from "../../src/engine/compaction-scheduler.ts";
import {
    CompactionRejectedError,
    type CompactionProposal,
    type CompactionRequest,
    type CompactionStrategyDefinition,
} from "../../src/engine/compaction.ts";
import { CompletionUnavailableError } from
    "../../src/engine/completion-service.ts";
import type { ContextMeasurement } from
    "../../src/engine/context-measurement.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("the trigger is a fraction of the window, so it fires on any model", () => {
    expect(shouldCompact(measurement(8_200))).toBe(true);
    expect(shouldCompact(measurement(8_100))).toBe(false);
    expect(COMPACTION_TRIGGER_FRACTION).toBeLessThan(1);
});

test("a session with no known window is never compacted on a token count alone", () => {
    expect(shouldCompact({ tokens: 900_000, estimated: false })).toBe(false);
    expect(shouldCompact(undefined)).toBe(false);
});

test("compacting replaces the span and leaves the transcript whole", async () => {
    const store = await session(6);
    const messages = store.messages();
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    // The transcript is what clients render, so it keeps every message; only
    // what the model is sent changes.
    expect(store.messages()).toEqual(messages);
    const context = store.modelContext();
    expect(context.length).toBeLessThan(messages.length);
    expect(context[0]).toEqual(summary());
});

test("the last two user turns survive verbatim", async () => {
    const store = await session(6);
    await compactSession(
        options(store, () => ({ projection: [summary()] })),
        measurement(8_000),
        new AbortController().signal,
    );

    const context = store.modelContext();
    const users = context.filter((message) => message.role === "user");
    // The summary is itself a user message, so two originals sit behind it.
    expect(users.length).toBe(3);
    expect(text(users[1])).toBe("turn 5");
    expect(text(users[2])).toBe("turn 6");
});

test("a session with nothing behind the kept turns has no boundary to use", async () => {
    const store = await session(2);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("no_boundary");
});

test("a projection that does not shrink the context is refused", async () => {
    // A model call that changes nothing would leave the next turn asking again
    // immediately, one call poorer each time.
    const store = await session(6);
    const whole = store.messages();
    const result = await compactSession(
        options(store, () => ({ projection: whole })),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("rejected");
    expect(store.latestCompaction()).toBeUndefined();
});

test("a rejected proposal leaves the previous context exactly as it was", async () => {
    const store = await session(6);
    const before = store.modelContext();
    const result = await compactSession(
        options(store, () => {
            throw new CompactionRejectedError("nope");
        }),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(result).toEqual({ outcome: "rejected", reason: "nope" });
    expect(store.modelContext()).toEqual(before);
});

test("a model that cannot answer is reported as unavailable, not as a rejection", async () => {
    const store = await session(6);
    const result = await compactSession(
        options(store, () => {
            throw new CompletionUnavailableError("no route");
        }),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("unavailable");
    expect(store.latestCompaction()).toBeUndefined();
});

test("cancellation appends nothing", async () => {
    const store = await session(6);
    const controller = new AbortController();
    const result = await compactSession(
        options(store, () => {
            controller.abort();
            return { projection: [summary()] };
        }),
        measurement(8_000),
        controller.signal,
    );

    expect(result).toEqual({ outcome: "cancelled" });
    expect(store.latestCompaction()).toBeUndefined();
});

test("compacting twice builds on the previous projection", async () => {
    const store = await session(6);
    await compactSession(
        options(store, () => ({ projection: [summary("first")] })),
        measurement(8_000),
        new AbortController().signal,
    );
    await appendTurn(store, 7);
    await appendTurn(store, 8);

    let seen: readonly ModelMessage[] = [];
    const result = await compactSession(
        options(store, (request) => {
            seen = request.messages;
            return { projection: [summary("second")] };
        }),
        measurement(5_500),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    // The second strategy call is handed the first summary, not the raw
    // history it already stood in for.
    expect(seen[0]).toEqual(summary("first"));
    expect(store.modelContext()[0]).toEqual(summary("second"));
});

test("the strategy cannot reach past its answer to change the transcript", async () => {
    const store = await session(6);
    await compactSession(
        options(store, (request) => {
            expect(() => {
                (request.messages as ModelMessage[]).push(summary());
            }).toThrow();
            return { projection: [summary()] };
        }),
        measurement(8_000),
        new AbortController().signal,
    );
});

function options(
    store: SessionStore,
    compact: (request: CompactionRequest) => CompactionProposal,
): CompactionSchedulerOptions {
    const strategy: CompactionStrategyDefinition = {
        id: "test/fake",
        models: [],
        compact: async (request) => compact(request),
    };
    return { store, strategy, models: {} };
}

async function session(turns: number): Promise<SessionStore> {
    const directory = mkdtempSync(join(tmpdir(), "vera-compaction-"));
    temporaryDirectories.push(directory);
    const store = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "session-1",
        cwd: directory,
    });
    for (let turn = 1; turn <= turns; turn += 1) {
        await appendTurn(store, turn);
    }
    return store;
}

async function appendTurn(store: SessionStore, turn: number): Promise<void> {
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: `turn ${turn}` }],
    });
    await store.appendMessage({
        role: "assistant",
        content: [
            { type: "text", text: `answer ${turn} ${"detail ".repeat(700)}` },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
}

function summary(text = "a summary of what came before"): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function text(message: ModelMessage | undefined): string {
    const block = message?.content[0];
    return block !== undefined && block.type === "text" ? block.text : "";
}

function measurement(tokens: number): ContextMeasurement {
    return { tokens, capacity: 10_000, estimated: true };
}
