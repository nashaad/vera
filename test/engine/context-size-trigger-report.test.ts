import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCompactionController } from "../../src/engine/compaction-controller.ts";
import type { ContextSizeTriggerEvent } from "../../src/engine/events.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { assembleAgedToolResults, type ToolResultHistoryEntry } from "../../src/engine/tool-result-history.ts";
import type { ContextSizeTriggerReport } from "../../src/engine/context-size-triggers.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const SPILL_DIRECTORY = "tool-results";

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "test", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function toolCall(id: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "grep", input: { pattern: "chest" } }],
        source: { provider: "test", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function toolResult(id: string, text: string, spillPath: string): ModelMessage {
    return {
        role: "tool_result",
        toolCallId: id,
        toolName: "grep",
        content: [{ type: "text", text }],
        isError: false,
        toolResultSource: {
            originalBytes: Buffer.byteLength(text, "utf8"),
            spillPath,
        },
    };
}

async function session(
    root: string,
    messages: readonly ModelMessage[],
): Promise<SessionStore> {
    const store = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "ship",
        cwd: root,
    });
    for (const message of messages) await store.appendMessage(message);
    return store;
}

function triggers(events: EngineEventBus): ContextSizeTriggerEvent[] {
    const seen: ContextSizeTriggerEvent[] = [];
    events.subscribe((event) => {
        if (event.type === "context_size_trigger") seen.push(event);
    });
    return seen;
}

test("a trim reports changed results and repeats wait for a new projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-trim-report-"));
    try {
        mkdirSync(join(root, SPILL_DIRECTORY));
        const output = "src/map.ts:12:buried chest\n".repeat(1_600);
        const spillPath = join(root, SPILL_DIRECTORY, "grep.txt");
        writeFileSync(spillPath, output);
        const store = await session(root, [
            user("first"),
            toolCall("call-1"),
            toolResult("call-1", output, spillPath),
            assistant("done"),
            user("second"),
        ]);
        const events = new EngineEventBus();
        const seen = triggers(events);
        const controller = createCompactionController({
            store,
            model: "wide",
            scratchDir: root,
            events,
            readCompaction: () => undefined,
            readToolResults: () => ({ agingLevel: "normal", stubAfterTurns: 1 }),
            inbound: {
                beginAutomaticCompaction() {},
                endAutomaticCompaction() {},
            },
            afterCompacted: async () => false,
        });

        const context = { model: "wide", capacity: 1 };
        const before = controller.modelContext(context);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            type: "context_size_trigger",
            reason: "pressure",
            policy: { id: "trim", kind: "every_n" },
            actions: ["trim"],
            capacity: 1,
        });
        expect(seen[0]!.tokensAfter).toBeLessThan(seen[0]!.tokens);
        controller.modelContext(context);

        expect(seen).toHaveLength(1);
        expect(JSON.stringify(controller.modelContext(context)))
            .toBe(JSON.stringify(before));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an active-turn stub reports once with the stubbed indices", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-stub-report-"));
    try {
        const store = await session(root, [
            user("start"),
            toolCall("first"),
            toolResult("first", "a".repeat(40_000), join(root, "unused-a.txt")),
            toolCall("second"),
            toolResult("second", "b".repeat(40_000), join(root, "unused-b.txt")),
        ]);
        const events = new EngineEventBus();
        const seen = triggers(events);
        const controller = createCompactionController({
            store,
            model: "wide",
            scratchDir: root,
            events,
            readCompaction: () => undefined,
            readToolResults: () => ({
                agingLevel: "normal",
                totalBudgetBytes: 1_000_000,
            }),
            inbound: {
                beginAutomaticCompaction() {},
                endAutomaticCompaction() {},
            },
            afterCompacted: async () => false,
        });

        controller.modelContext({ model: "wide", capacity: 10_000 });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            type: "context_size_trigger",
            reason: "pressure",
            policy: { id: "active_turn", kind: "high_low" },
            actions: ["stub_active_turn"],
            capacity: 10_000,
        });
        expect(seen[0]!.tokens).toBeGreaterThan(7_500);
        expect(typeof seen[0]!.tokensAfter).toBe("number");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a projection that changes nothing reports nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-quiet-report-"));
    try {
        const store = await session(root, [
            user("first"),
            toolCall("call-1"),
            toolResult("call-1", "small result", join(root, "unused.txt")),
            assistant("done"),
            user("second"),
        ]);
        const events = new EngineEventBus();
        const seen = triggers(events);
        const controller = createCompactionController({
            store,
            model: "wide",
            scratchDir: root,
            events,
            readCompaction: () => undefined,
            readToolResults: () => ({ totalBudgetBytes: 1_000_000 }),
            inbound: {
                beginAutomaticCompaction() {},
                endAutomaticCompaction() {},
            },
            afterCompacted: async () => false,
        });

        controller.modelContext({ model: "wide", capacity: 200_000 });
        expect(seen).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a reporter that drops the report never pays to measure it", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-lazy-tokens-after-"));
    try {
        const output = "src/map.ts:12:buried chest\n".repeat(1_600);
        const spillPath = join(root, "grep.txt");
        writeFileSync(spillPath, output);
        const entries: ToolResultHistoryEntry[] = [
            { message: user("first") },
            { message: toolCall("call-1") },
            { message: toolResult("call-1", output, spillPath) },
            { message: assistant("done") },
            { message: user("second") },
        ];
        const reports: ContextSizeTriggerReport[] = [];
        assembleAgedToolResults(entries, {
            capacity: 1,
            level: "normal" as const,
            ageAfterTurns: 1,
            overheadTokens: 0,
            budgetBytes: 1_000_000,
            reportTrigger: (report) => reports.push(report),
        }, null);

        const report = reports[0]!;
        const descriptor = Object.getOwnPropertyDescriptor(report, "tokensAfter");
        expect(typeof descriptor?.get).toBe("function");
        const measured = report.tokensAfter;
        expect(measured).toBeLessThan(report.trigger.tokens);
        expect(report.tokensAfter).toBe(measured);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a reporter does not change the projection", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-report-projection-"));
    try {
        const output = "src/map.ts:12:buried chest\n".repeat(1_600);
        const spillPath = join(root, "grep.txt");
        writeFileSync(spillPath, output);
        const entries: ToolResultHistoryEntry[] = [
            { message: user("first") },
            { message: toolCall("call-1") },
            { message: toolResult("call-1", output, spillPath) },
            { message: assistant("done") },
            { message: user("second") },
        ];
        const policy = {
            capacity: 1,
            level: "normal" as const,
            ageAfterTurns: 1,
            overheadTokens: 0,
            budgetBytes: 1_000_000,
        };
        const reports: unknown[] = [];
        const withReporter = assembleAgedToolResults(entries, {
            ...policy,
            reportTrigger: (report) => reports.push(report),
        }, null);
        const withoutReporter = assembleAgedToolResults(entries, policy, null);
        expect(JSON.stringify(withReporter)).toBe(JSON.stringify(withoutReporter));
        expect(reports.length).toBeGreaterThan(0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
