import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    COMPACTION_TRIGGER_FRACTION,
    compactionBudgetWarning,
    compactionTargetBudget,
    compactSession,
    MAX_COMPACTION_ATTEMPTS,
    MIN_SUMMARY_TOKENS,
    shouldCompact,
    UNKNOWN_CAPACITY_TARGET_FRACTION,
    UNKNOWN_CAPACITY_TRIGGER_TOKENS,
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
import {
    measureMessages,
    type ContextMeasurement,
} from "../../src/engine/context-measurement.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { assertToolCallsPaired } from "../../src/model/tool-pairing.ts";
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

test("a session with no known window compacts at the default token count", () => {
    expect(shouldCompact({ tokens: 900_000, estimated: false })).toBe(true);
    expect(shouldCompact({
        tokens: UNKNOWN_CAPACITY_TRIGGER_TOKENS,
        estimated: false,
    })).toBe(true);
    expect(shouldCompact({
        tokens: UNKNOWN_CAPACITY_TRIGGER_TOKENS - 1,
        estimated: false,
    })).toBe(false);
    expect(shouldCompact(undefined)).toBe(false);
});

test("a configured token trigger wins over the default", () => {
    const unknown = { tokens: 30_000, estimated: false };
    expect(shouldCompact(unknown, { tokens: 30_000 })).toBe(true);
    expect(shouldCompact(
        { tokens: UNKNOWN_CAPACITY_TRIGGER_TOKENS, estimated: false },
        { tokens: 500_000 },
    )).toBe(false);
});

test("a known window ignores the default token trigger", () => {
    expect(shouldCompact(measurement(8_100))).toBe(false);
    expect(shouldCompact({
        tokens: 50_000,
        capacity: 200_000,
        estimated: true,
    })).toBe(false);
});

test("a configured fraction fires earlier than the default", () => {
    expect(shouldCompact(measurement(3_000), { fraction: 0.2 })).toBe(true);
    expect(shouldCompact(measurement(3_000))).toBe(false);
    expect(shouldCompact(measurement(1_999), { fraction: 0.2 })).toBe(false);
});

test("a token floor fires before the fraction does", () => {
    expect(shouldCompact(measurement(5_000), { tokens: 5_000 })).toBe(true);
    expect(shouldCompact(measurement(4_999), { tokens: 5_000 })).toBe(false);
    // The fraction still fires on its own when the floor is out of reach.
    expect(shouldCompact(measurement(8_200), { tokens: 500_000 })).toBe(true);
});

test("a token floor is what compacts a session with no known window", () => {
    const unknown = { tokens: 30_000, estimated: false };
    expect(shouldCompact(unknown, { tokens: 30_000 })).toBe(true);
    expect(shouldCompact(unknown, { tokens: 30_001 })).toBe(false);
    expect(shouldCompact(unknown, { fraction: 0.2 })).toBe(false);
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

test("boundary budgeting uses the model-facing retained projection", async () => {
    const store = await session(6);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] }), {
            targetTokens: 1_000,
            modelContext: store.modelContext(),
            projectModelContext: (projection, retained) => [
                ...projection,
                ...retained.map(() => summary("aged result")),
            ],
        }),
        { tokens: 5_000, estimated: true },
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
});

test("compaction reports the model that produced the accepted projection", async () => {
    const store = await session(6);
    const result = await compactSession(
        options(store, () => ({
            projection: [summary()],
            model: "fallback-model",
            provider: "fallback-provider",
        }), {
            diagnostics: {
                strategy: "test/fake",
                model: "first-model",
                provider: "first-provider",
            },
        }),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(result).toMatchObject({
        outcome: "compacted",
        model: "fallback-model",
        provider: "fallback-provider",
    });
    expect(store.latestCompaction()?.diagnostics).toMatchObject({
        model: "fallback-model",
        provider: "fallback-provider",
    });
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

test("compaction never crosses a marked context barrier", async () => {
    const store = await session(6);
    const barrier: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "reference-only boundary" }],
        internal: true,
        compactionBarrier: true,
    };
    await store.appendMessage(barrier);
    let summarized: readonly ModelMessage[] = [];

    const first = await compactSession(
        options(store, (request) => {
            summarized = request.messages;
            return { projection: [summary()] };
        }),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(first.outcome).toBe("compacted");
    expect(summarized).not.toContainEqual(barrier);
    expect(store.modelContext()).toContainEqual(barrier);
    await appendTurn(store, 7);
    await appendTurn(store, 8);
    expect(store.modelContext().map(text)).toContain("turn 8");

    const second = await compactSession(
        options(store, () => ({ projection: [summary("second")] })),
        measurement(8_000),
        new AbortController().signal,
    );
    expect(second.outcome).toBe("no_boundary");
    expect(store.modelContext()).toContainEqual(barrier);
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

test("a cancel that lands as the summarizer answers still appends nothing", async () => {
    // Cancel means cancel. The answer arrives normally rather than throwing
    // when it was cached or already buffered, so the signal is read again
    // after the call as well as in the catch.
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

    expect(result.outcome).toBe("cancelled");
    expect(store.latestCompaction()).toBeUndefined();
});

test("a cancel before the summarizer is called appends nothing", async () => {
    const store = await session(6);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await compactSession(
        options(store, () => {
            calls += 1;
            return { projection: [summary()] };
        }),
        measurement(8_000),
        controller.signal,
    );

    expect(result).toEqual({ outcome: "cancelled" });
    expect(calls).toBe(0);
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
    const transcript = structuredClone(store.messages());
    await compactSession(
        options(store, (request) => {
            expect(() => {
                (request.messages as ModelMessage[]).push(summary());
            }).toThrow();
            // Deep, not just the array: the content blocks are where a write
            // would silently rewrite what the store believes was said.
            const block = request.messages[0]?.content[0];
            expect(() => {
                (block as { text: string }).text = "corrupted";
            }).toThrow();
            return { projection: [summary()] };
        }),
        measurement(8_000),
        new AbortController().signal,
    );
    expect(store.messages()).toEqual(transcript);
});

test("a turn too big for the budget falls back to keeping one turn", async () => {
    const store = await session(6);
    await compactSession(
        options(store, () => ({ projection: [summary()] })),
        // Room for a summary and one of these turns, but not two.
        pressure(store, 6_000),
        new AbortController().signal,
    );

    const users = store.modelContext()
        .filter((message) => message.role === "user");
    // The summary plus the single newest turn, where the preferred cut would
    // have kept two and found no room for a summary at all.
    expect(users.length).toBe(2);
    expect(text(users[1])).toBe("turn 6");
});

test("a newest turn bigger than the budget is cut into, not declined", async () => {
    const store = await session(3);
    await appendToolTurn(store, 4);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        // Below what the whole newest turn needs, so no user-message cut fits.
        pressure(store, 6_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    const context = store.modelContext();
    expect(context[0]).toEqual(summary());
    // The seam fell inside the newest turn, so the user message that opened it
    // went into the summary and only the tail survives verbatim.
    expect(context.map(text)).not.toContain("turn 4");
    expect(context[1]?.role).toBe("assistant");
});

test("a second cut inside one turn finds another seam, not keep-nothing", async () => {
    const store = await session(3);
    await appendToolTurn(store, 4);
    const first = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        // Tight enough to land the boundary inside turn 4.
        pressure(store, 6_000),
        new AbortController().signal,
    );
    expect(first.outcome).toBe("compacted");
    expect(keptSuffix(store)[0]?.role).toBe("assistant");

    // The turn keeps going: more rounds land after that boundary.
    await appendToolRounds(store, 4);
    const second = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        pressure(store, 8_000),
        new AbortController().signal,
    );

    expect(second.outcome).toBe("compacted");
    // The boundary already sat past the turn's user message, so anchoring the
    // seam search on that message would have left keep-nothing as the only
    // rung and thrown the new rounds away.
    const kept = keptSuffix(store);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]?.role).toBe("assistant");
    assertToolCallsPaired(store.modelContext(), "The compacted context");
});

test("a summarizer that overshoots drops the ladder to a looser rung", async () => {
    const store = await session(6);
    const targets: number[] = [];
    const result = await compactSession(
        options(store, (request) => {
            targets.push(request.targetTokens);
            // Over the target the first time, inside it after that. The rung
            // had room by measurement, so nothing but a retry recovers.
            return targets.length === 1
                ? { projection: [summary("over ".repeat(4_000))] }
                : { projection: [summary()] };
        }),
        pressure(store, 10_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    expect(targets.length).toBe(2);
    // The second rung keeps less verbatim, so it asks for a bigger summary.
    expect(targets[1]).toBeGreaterThan(targets[0] ?? 0);
    expect(store.modelContext()[0]).toEqual(summary());
});

test("a summarizer that always overshoots reports the rejection, once", async () => {
    const store = await session(6);
    let calls = 0;
    const result = await compactSession(
        options(store, () => {
            calls += 1;
            return { projection: [summary("over ".repeat(4_000))] };
        }),
        pressure(store, 10_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("rejected");
    // Bounded: a session that cannot be summarized must not spend calls
    // walking every seam in it.
    expect(calls).toBeLessThanOrEqual(MAX_COMPACTION_ATTEMPTS);
    expect(store.latestCompaction()).toBeUndefined();
});

test("a structural rejection is not retried down the ladder", async () => {
    const store = await session(6);
    let calls = 0;
    const result = await compactSession(
        options(store, () => {
            calls += 1;
            // A fault no amount of extra room changes, so every rung would
            // return it again.
            return {
                projection: [{
                    role: "tool_result",
                    toolCallId: "call-1",
                    toolName: "read",
                    content: [{ type: "text", text: "x" }],
                    isError: false,
                }],
            };
        }),
        pressure(store, 10_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("rejected");
    expect(calls).toBe(1);
});

test("the ladder keeps its failsafe rung when the cap trims the middle", async () => {
    const store = await session(8);
    const targets: number[] = [];
    const result = await compactSession(
        options(store, (request) => {
            targets.push(request.targetTokens);
            // Only the rung that keeps nothing verbatim has room for this one.
            return request.targetTokens < 4_000
                ? { projection: [summary("over ".repeat(4_000))] }
                : { projection: [summary()] };
        }, {
            // More rungs than the cap allows, so it has to drop some of them.
            retainedUserTurns: 5,
        }),
        pressure(store, 10_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    expect(targets.length).toBeLessThanOrEqual(MAX_COMPACTION_ATTEMPTS);
    // Keep nothing verbatim is the loosest rung there is, and the cap must
    // spend its last attempt on that rather than on another tight seam.
    expect(store.modelContext()).toEqual([summary()]);
});

test("a compaction cancelled during a rung stops calling the summarizer", async () => {
    const store = await session(6);
    const controller = new AbortController();
    let calls = 0;
    const result = await compactSession(
        options(store, () => {
            calls += 1;
            // Cancelled while the first rung was being summarized.
            controller.abort();
            return { projection: [summary("over ".repeat(4_000))] };
        }),
        pressure(store, 10_000),
        controller.signal,
    );

    expect(result.outcome).toBe("cancelled");
    expect(calls).toBe(1);
});

test("an unavailable summarizer is not retried down the ladder", async () => {
    const store = await session(6);
    let calls = 0;
    const result = await compactSession(
        options(store, () => {
            calls += 1;
            throw new CompletionUnavailableError("no model");
        }),
        pressure(store, 10_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("unavailable");
    expect(calls).toBe(1);
});

test("the ladder gives up less verbatim as the window tightens", async () => {
    let previousKept = Number.POSITIVE_INFINITY;
    let sawSeam = false;
    for (const capacity of [10_000, 8_000, 6_000, 4_500, 3_000, 2_000]) {
        // A fresh session each time: compacting appends a record, and reusing
        // one store would measure the previous run's result, not the fixture.
        const probe = await session(3);
        await appendToolTurn(probe, 4);
        const result = await compactSession(
            options(probe, () => ({ projection: [summary()] })),
            pressure(probe, capacity),
            new AbortController().signal,
        );
        expect(result.outcome).toBe("compacted");
        const kept = keptSuffix(probe);
        // Each tighter window keeps no more than the one before it.
        expect(kept.length).toBeLessThanOrEqual(previousKept);
        previousKept = kept.length;
        // A suffix opening on a tool result is a call whose pair went into the
        // summary, which every provider rejects.
        expect(kept[0]?.role).not.toBe("tool_result");
        assertToolCallsPaired(probe.modelContext(), "The compacted context");
        if (kept.length > 0 && kept[0]?.role === "assistant") {
            sawSeam = true;
        }
    }
    // The point of the ladder: at least one window landed inside a turn.
    expect(sawSeam).toBe(true);
    // The tightest window kept nothing verbatim at all.
    expect(previousKept).toBe(0);
});

test("a session that fits nothing verbatim still compacts", async () => {
    const store = await session(3);
    await appendToolTurn(store, 4);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        // Only the summary itself fits.
        pressure(store, 2_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    expect(store.modelContext()).toEqual([summary()]);
});

test("overhead that fills the target is reported, not silently declined", async () => {
    const store = await session(6);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        // The measured request is far above what the messages account for, so
        // the fixed overhead alone eats the target.
        { tokens: 100_000, capacity: 10_000, estimated: true },
        new AbortController().signal,
    );

    expect(result.outcome).toBe("no_boundary");
    expect(result).toHaveProperty("reason");
    if (result.outcome === "no_boundary") {
        expect(result.reason).toContain("verbatim");
    }
});

test("the ladder never crosses a barrier to find room", async () => {
    const store = await session(4);
    const barrier: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: "reference-only boundary" }],
        internal: true,
        compactionBarrier: true,
    };
    await store.appendMessage(barrier);
    await appendToolTurn(store, 5);

    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        // Tight enough that every rung past the barrier would be tried.
        pressure(store, 2_000),
        new AbortController().signal,
    );

    // Either it found room at the barrier or it declined, but the barrier and
    // everything after it is still there verbatim.
    expect(store.modelContext()).toContainEqual(barrier);
    if (result.outcome === "compacted") {
        expect(store.modelContext().map(text)).toContain("turn 5");
    }
});

test("retained turns are configurable, and one turn is a legal setting", async () => {
    const store = await session(6);
    await compactSession(
        options(store, () => ({ projection: [summary()] }), {
            retainedUserTurns: 1,
        }),
        measurement(8_000),
        new AbortController().signal,
    );

    const users = store.modelContext()
        .filter((message) => message.role === "user");
    expect(users.length).toBe(2);
    expect(text(users[1])).toBe("turn 6");
});

test("a compacted intra-turn seam reads back from the store it was written to",
    async () => {
        const store = await session(3);
        await appendToolTurn(store, 4);
        const result = await compactSession(
            options(store, () => ({ projection: [summary("anchored")] })),
            pressure(store, 6_000),
            new AbortController().signal,
        );
        expect(result.outcome).toBe("compacted");

        const reopened = await SessionStore.open(store.path);
        expect(reopened.modelContext()).toEqual(store.modelContext());
        expect(reopened.modelContext()[0]).toEqual(summary("anchored"));
        // The transcript is untouched whatever the boundary did to the context.
        expect(reopened.messages()).toEqual(store.messages());
        assertToolCallsPaired(reopened.modelContext(), "The reopened context");
    });

/** A turn shaped like a real agentic one: one prompt, then a tool loop. */
/** More finished rounds of an already-open turn, with no user message. */
async function appendToolRounds(
    store: SessionStore,
    turn: number,
): Promise<void> {
    for (let round = 4; round <= 6; round += 1) {
        const id = `call-${turn}-${round}`;
        await store.appendMessage({
            role: "assistant",
            content: [
                { type: "text", text: `step ${round} ${"detail ".repeat(300)}` },
                {
                    type: "tool_call",
                    id,
                    name: "read",
                    input: { path: `src/file-${round}.ts` },
                },
            ],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendMessage({
            role: "tool_result",
            toolCallId: id,
            toolName: "read",
            content: [{ type: "text", text: `output ${"x ".repeat(300)}` }],
            isError: false,
        });
    }
}

async function appendToolTurn(
    store: SessionStore,
    turn: number,
): Promise<void> {
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: `turn ${turn}` }],
    });
    for (let round = 1; round <= 3; round += 1) {
        const id = `call-${turn}-${round}`;
        await store.appendMessage({
            role: "assistant",
            content: [
                { type: "text", text: `step ${round} ${"detail ".repeat(300)}` },
                {
                    type: "tool_call",
                    id,
                    name: "read",
                    input: { path: `src/file-${round}.ts` },
                },
            ],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendMessage({
            role: "tool_result",
            toolCallId: id,
            toolName: "read",
            content: [{ type: "text", text: `output ${"x ".repeat(300)}` }],
            isError: false,
        });
    }
    await store.appendMessage({
        role: "assistant",
        content: [
            { type: "text", text: `answer ${turn} ${"detail ".repeat(280)}` },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
}

/**
 * What the request measures at when the window is `capacity`. Derived from the
 * store rather than written down, so the fixtures can change size without the
 * ladder tests turning into arithmetic about them.
 */
const FIXED_OVERHEAD = 200;

function pressure(
    store: SessionStore,
    capacity: number,
): ContextMeasurement {
    return {
        tokens: measureMessages(store.modelContext()) + FIXED_OVERHEAD,
        capacity,
        estimated: true,
    };
}

/** The messages kept verbatim after the boundary the run chose. */
function keptSuffix(store: SessionStore): readonly ModelMessage[] {
    const context = store.modelContext();
    return context[0] === undefined ? context : context.slice(1);
}

function options(
    store: SessionStore,
    compact: (request: CompactionRequest) => CompactionProposal,
    budget: Partial<CompactionSchedulerOptions> = {},
): CompactionSchedulerOptions {
    const strategy: CompactionStrategyDefinition = {
        id: "test/fake",
        models: [],
        compact: async (request) => compact(request),
    };
    return { store, strategy, models: {}, ...budget };
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

test("a stated overhead is used rather than recovered by subtraction", async () => {
    // `measurement.tokens` may be scaled into the provider's units while the
    // budget and the message measurements are raw estimator units. Recovering
    // the overhead by subtracting one from the other folds the whole
    // transcript's calibration into it, and every rung then reads as having
    // no room.
    const store = await session(6);
    const scaled = {
        tokens: 24_000,
        capacity: 10_000,
        estimated: true,
        overheadTokens: 500,
    };
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        scaled,
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
});

test("a route that ran out of room lets the ladder try a shorter span", async () => {
    // "The request does not fit the summarizer's window" is the most room
    // related failure there is: the next rung summarizes less. Reporting it as
    // final kills the ladder on the first and largest rung.
    const store = await session(6);
    let calls = 0;
    const result = await compactSession(
        options(store, () => {
            calls += 1;
            if (calls === 1) {
                throw new CompletionUnavailableError("no room", true);
            }
            return { projection: [summary()] };
        }),
        pressure(store, 10_000),
        new AbortController().signal,
    );

    expect(calls).toBeGreaterThan(1);
    expect(result.outcome).toBe("compacted");
});

test("a route that failed for any other reason stops the ladder", async () => {
    const store = await session(6);
    let calls = 0;
    const result = await compactSession(
        options(store, () => {
            calls += 1;
            throw new CompletionUnavailableError("no key");
        }),
        measurement(8_000),
        new AbortController().signal,
    );

    expect(calls).toBe(1);
    expect(result.outcome).toBe("unavailable");
});

test("a known window sizes the target, whatever the configured tokens say", () => {
    expect(compactionTargetBudget(measurement(9_000))).toBe(4_500);
    expect(compactionTargetBudget(measurement(9_000), {
        trigger: { tokens: 1_000 },
        targetTokens: 700,
    })).toBe(4_500);
});

test("an unknown window derives its target from the token trigger", () => {
    const unknown: ContextMeasurement = { tokens: 30_000, estimated: false };
    expect(compactionTargetBudget(unknown, { trigger: { tokens: 30_000 } }))
        .toBe(Math.floor(30_000 * UNKNOWN_CAPACITY_TARGET_FRACTION));
    expect(UNKNOWN_CAPACITY_TARGET_FRACTION).toBeLessThan(0.5);
});

test("an explicit target wins over the one derived from the trigger", () => {
    const unknown: ContextMeasurement = { tokens: 30_000, estimated: false };
    expect(compactionTargetBudget(unknown, {
        trigger: { tokens: 30_000 },
        targetTokens: 12_000,
    })).toBe(12_000);
});

test("an unknown window with nothing configured targets the default share", () => {
    const unknown: ContextMeasurement = { tokens: 30_000, estimated: false };
    expect(compactionTargetBudget(unknown)).toBe(35_000);
    expect(compactionTargetBudget(unknown, { trigger: { fraction: 0.2 } }))
        .toBe(35_000);
    expect(35_000).toBe(Math.floor(
        UNKNOWN_CAPACITY_TRIGGER_TOKENS * UNKNOWN_CAPACITY_TARGET_FRACTION,
    ));
});

test("the default trigger does not warn about its own derived target", () => {
    const unknown: ContextMeasurement = { tokens: 30_000, estimated: false };
    expect(compactionBudgetWarning(unknown)).toBeUndefined();
});

test("a session with no window compacts once it has a target to aim for", async () => {
    const store = await session(6);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] }), {
            trigger: { tokens: 20_000 },
        }),
        { tokens: 8_000, estimated: false },
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    expect(store.modelContext()[0]).toEqual(summary());
    // A record written with no window has to read back as one.
    const reopened = await SessionStore.open(store.path);
    expect(reopened.latestCompaction()?.measured.contextWindow)
        .toBeUndefined();
    expect(reopened.modelContext()[0]).toEqual(summary());
});

test("a session with no window and nothing configured uses the default target", async () => {
    const store = await session(6);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] })),
        { tokens: 8_000, estimated: false },
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    expect(store.modelContext()[0]).toEqual(summary());
});

test("a derived target too small for a summary asks for none", async () => {
    const store = await session(6);
    const result = await compactSession(
        options(store, () => ({ projection: [summary()] }), {
            targetTokens: MIN_SUMMARY_TOKENS - 1,
        }),
        { tokens: 8_000, estimated: false },
        new AbortController().signal,
    );

    expect(result.outcome).toBe("no_boundary");
});

test("a target above the token trigger is reported rather than clamped", () => {
    // The wasteful case: a low floor on a large window leaves the target above
    // the trigger, so compacting cannot get the request back under it.
    const warning = compactionBudgetWarning(
        { tokens: 5_000, capacity: 200_000, estimated: true },
        { trigger: { tokens: 5_000 } },
    );

    expect(warning).toContain("90000");
    expect(warning).toContain("5000");
    expect(compactionBudgetWarning(
        measurement(9_000),
        { trigger: { tokens: 5_000 } },
    )).toBeUndefined();
    expect(compactionBudgetWarning(measurement(9_000))).toBeUndefined();
});

test("a target_tokens a known window makes moot is reported, not swallowed",
    () => {
        const warning = compactionBudgetWarning(measurement(9_000), {
            targetTokens: 2_000,
        });

        expect(warning).toContain("compaction.target_tokens (2000)");
        expect(warning).toContain("10000");
        expect(warning).toContain("4500");
        // No such key exists, so the text must not send anyone looking for it.
        expect(warning).not.toContain("target_fraction");
    });

test("an unknown window uses target_tokens, so there is nothing to report",
    () => {
        expect(compactionBudgetWarning(
            { tokens: 9_000, estimated: true },
            { targetTokens: 2_000, trigger: { tokens: 8_000 } },
        )).toBeUndefined();
        expect(compactionBudgetWarning(measurement(9_000), {
            trigger: { tokens: 8_000 },
        })).toBeUndefined();
    });

test("both budget faults reach the user in one warning", () => {
    // Known window, so target_tokens is ignored, and the share of the window
    // it is ignored in favour of still sits above the token trigger.
    const warning = compactionBudgetWarning(
        { tokens: 5_000, capacity: 200_000, estimated: true },
        { targetTokens: 2_000, trigger: { tokens: 5_000 } },
    );

    expect(warning).toContain("compaction.target_tokens (2000) is ignored");
    expect(warning).toContain("above trigger_tokens");
});

test("a developer target fraction replaces the built-in share of the window", () => {
    expect(compactionTargetBudget(measurement(9_000), {
        postCompactionTargetFraction: 0.2,
    })).toBe(2_000);
});
