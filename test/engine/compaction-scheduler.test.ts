import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    COMPACTION_TRIGGER_FRACTION,
    compactionBudgetWarning,
    compactionTargetBudget,
    compactSession,
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
