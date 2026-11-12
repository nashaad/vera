import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dropOldestStrategy } from "../../src/engine/compaction-drop-oldest.ts";
import type { CompactionStrategyDefinition } from "../../src/engine/compaction.ts";
import {
    compactionTargetBudget,
    compactSession,
    type CompactionSchedulerOptions,
} from "../../src/engine/compaction-scheduler.ts";
import {
    measureMessages,
    type ContextMeasurement,
} from "../../src/engine/context-measurement.ts";
import { assertToolCallsPaired } from "../../src/model/tool-pairing.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const CAPACITY = 10_000;
const OVERHEAD_TOKENS = 200;
const ROUNDS = 30;
const PROMPT_MARKER = "PROMPT:";
const SOURCE = { provider: "faux", api: "scripted", model: "test" } as const;
const SUMMARY: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: "summary" }],
};

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

for (const promptRepeats of [420, 660]) {
    test(`a long running turn with a ${promptRepeats}-repeat prompt over budget compacts to its prompt once and its newest steps`, async () => {
        const store = await openSession();
        await appendLongTurn(store, ROUNDS, promptRepeats);
        const measurement = pressure(store);
        const options: CompactionSchedulerOptions = {
            store,
            strategy: dropOldestStrategy,
            models: {},
        };
        expect(compactionTargetBudget(measurement, options)).toBe(4_500);
        expect(measurement.tokens).toBeGreaterThan(8_200);

        const outcome = await compactSession(
            options,
            measurement,
            new AbortController().signal,
        );

        if (outcome.outcome !== "compacted") {
            throw new Error(`expected a compaction, got ${outcome.outcome}`);
        }
        expect(outcome.after).toBeLessThanOrEqual(4_500);

        const context = store.modelContext();
        expect(measureMessages(context) + OVERHEAD_TOKENS).toBeLessThanOrEqual(4_500);
        expect(() => assertToolCallsPaired(context, "context")).not.toThrow();
        expect(textOf(context.at(0))).toContain(PROMPT_MARKER);
        expect(
            context.filter((message) => textOf(message).includes(PROMPT_MARKER)),
        ).toHaveLength(1);

        const rounds = keptRounds(context);
        expect(rounds.length).toBeGreaterThan(0);
        expect(rounds.at(0)).toBeGreaterThan(1);
        const first = ROUNDS - rounds.length + 1;
        expect(rounds).toEqual(
            Array.from({ length: rounds.length }, (_, index) => first + index),
        );
    });
}

test("a strategy that keeps the prompt is rejected when its projection leaves the prompt out", async () => {
    const store = await openSession();
    await appendLongTurn(store, ROUNDS, 420);
    let calls = 0;
    const flagged: CompactionStrategyDefinition = {
        id: "test/flagged",
        models: [],
        keepsPrompt: true,
        compact: async () => {
            calls += 1;
            return { projection: [SUMMARY] };
        },
    };

    const outcome = await compactSession(
        { store, strategy: flagged, models: {} },
        pressure(store),
        new AbortController().signal,
    );

    expect(outcome).toEqual({
        outcome: "rejected",
        reason: "The compacted context does not hold the prompt being worked on.",
    });
    expect(calls).toBe(1);
    expect(store.latestCompaction()).toBeUndefined();
});

test("a strategy that keeps the prompt gets the prompt in its span and drops the turn before it", async () => {
    const store = await openSession();
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "first" }],
    });
    await store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "earlier reply ".repeat(1_500) }],
        source: SOURCE,
        usage: emptyUsage(),
        stopReason: "stop",
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: `${PROMPT_MARKER} rewrite the parser` }],
    });

    const outcome = await compactSession(
        { store, strategy: dropOldestStrategy, models: {} },
        pressure(store),
        new AbortController().signal,
    );

    expect(outcome.outcome).toBe("compacted");
    const context = store.modelContext();
    expect(context).toHaveLength(1);
    expect(textOf(context.at(0))).toContain(PROMPT_MARKER);
});

// The turn is still running, so the context ends on a tool result rather than an answer.
async function appendLongTurn(
    store: SessionStore,
    rounds: number,
    promptRepeats: number,
): Promise<void> {
    await store.appendMessage({
        role: "user",
        content: [
            {
                type: "text",
                text: `${PROMPT_MARKER} ${"rewrite the parser ".repeat(promptRepeats)}`,
            },
        ],
    });
    for (let round = 1; round <= rounds; round += 1) {
        const id = `call_${round}`;
        await store.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "tool_call",
                    id,
                    name: "read",
                    input: { path: `src/file-${round}.ts` },
                },
            ],
            source: SOURCE,
            usage: emptyUsage(),
            stopReason: "tool_use",
        });
        await store.appendMessage({
            role: "tool_result",
            toolCallId: id,
            toolName: "read",
            content: [
                { type: "text", text: `round ${round} ${"body ".repeat(250)}` },
            ],
            isError: false,
        });
    }
}

function openSession(): Promise<SessionStore> {
    const directory = mkdtempSync(join(tmpdir(), "vera-drop-oldest-scheduler-"));
    temporaryDirectories.push(directory);
    return SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "session-1",
        cwd: directory,
    });
}

function pressure(store: SessionStore): ContextMeasurement {
    return {
        tokens: measureMessages(store.modelContext()) + OVERHEAD_TOKENS,
        capacity: CAPACITY,
        estimated: true,
        overheadTokens: OVERHEAD_TOKENS,
    };
}

function keptRounds(messages: readonly ModelMessage[]): number[] {
    const rounds: number[] = [];
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_call") {
                rounds.push(Number(block.id.replace("call_", "")));
            }
        }
    }
    return rounds;
}

function textOf(message: ModelMessage | undefined): string {
    if (message === undefined) {
        return "";
    }
    return message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}
