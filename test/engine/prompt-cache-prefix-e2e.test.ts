import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
    FULL_SUMMARY_STRATEGY_ID,
} from "../../src/engine/compaction-full-summary.ts";
import { createRoutedCompletionService } from "../../src/engine/completion-service.ts";
import { measureMessages } from "../../src/engine/context-measurement.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    runHeadlessLoop,
    type SessionCompactionOptions,
} from "../../src/engine/run-turn.ts";
import {
    BYTE_TRIM_STEP_FRACTION,
    TOKEN_TRIM_STEP_FRACTION,
    TOOL_RESULT_AGING_LEVELS,
    toolResultAgingLevel,
} from "../../src/engine/tool-result-history.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelInputMessage,
    type ModelMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

// Earlier turns leave many results that are old enough to trim. The final turn
// then grows past a trim limit a little on each round. Every request that does
// not start with the previous request's messages makes the provider re-read the
// rest of the history at full price.

const WINDOW = 128_000;

interface PrefixScenario {
    readonly budgetBytes: number;
    readonly earlyTurns: number;
    readonly earlyResultBytes: number;
    readonly earlyReplyBytes: number;
    readonly finalRounds: number;
    readonly finalResultBytes: number;
}

interface PrefixOutcome {
    readonly breaks: number;
    readonly allowed: number;
}

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("@core trimming by context size changes the prompt prefix once per step, not on every request", async () => {
    const scenario: PrefixScenario = {
        budgetBytes: 64 * 1024 * 1024,
        earlyTurns: 50,
        earlyResultBytes: 6_000,
        earlyReplyBytes: 0,
        finalRounds: 15,
        finalResultBytes: 8_000,
    };
    const outcome = await runPrefixScenario(scenario);
    expect(outcome.breaks).toBeLessThanOrEqual(outcome.allowed);
    expect(scenario.finalRounds).toBeGreaterThan(outcome.allowed * 2);
});

test("@core the tool-result budget changes the prompt prefix once per step, not on every request", async () => {
    // Results under the verbatim floor are never digested, so only the byte
    // budget can trim them.
    const scenario: PrefixScenario = {
        budgetBytes: 48 * 1024,
        earlyTurns: 60,
        earlyResultBytes: 1_500,
        earlyReplyBytes: 4_000,
        finalRounds: 15,
        finalResultBytes: 1_500,
    };
    const outcome = await runPrefixScenario(scenario);
    expect(outcome.breaks).toBeLessThanOrEqual(outcome.allowed);
    expect(scenario.finalRounds).toBeGreaterThan(outcome.allowed * 2);
});

async function runPrefixScenario(
    scenario: PrefixScenario,
): Promise<PrefixOutcome> {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "prompt-prefix", cwd: workspace },
    );

    const script: AssistantMessage[] = [];
    const turns: string[] = [];
    for (let turn = 1; turn <= scenario.earlyTurns; turn += 1) {
        writeNotes(workspace, `early-${turn}.txt`, turn, scenario.earlyResultBytes);
        turns.push(`early ${turn}`);
        script.push(bashCall(`early-call-${turn}`, `early-${turn}.txt`));
        script.push(assistantText(
            `early ${turn} done. ${notes(turn, scenario.earlyReplyBytes)}`,
        ));
    }
    // Enough later turns that every early result is old enough to trim.
    for (let turn = 1; turn <= 5; turn += 1) {
        turns.push(`filler ${turn}`);
        script.push(assistantText(`filler ${turn} done`));
    }
    for (let round = 1; round <= scenario.finalRounds; round += 1) {
        writeNotes(workspace, `long-${round}.txt`, 1_000 + round, scenario.finalResultBytes);
        script.push(bashCall(`long-call-${round}`, `long-${round}.txt`));
    }
    script.push(assistantText("long job done"));

    const faux = new FauxAdapter(script);
    const sent: ModelRequest[] = [];
    const agent: ModelAdapter = {
        stream(request) {
            sent.push(request);
            return faux.stream(request);
        },
    };

    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        approvalMode: "auto",
    },
    {
        sessionStore: store,
        eventBus: new EngineEventBus(),
        compaction: compactionOptions({ fraction: 1, tokens: 10_000_000 }),
        readModelSettings: () => ({ model: "test", contextWindow: WINDOW }),
        toolResults: { totalBudgetBytes: scenario.budgetBytes },
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: {
            updateModelSettings: async () => undefined,
        },
    });

    for (const content of turns) {
        channel.client.send({ type: "prompt", content });
        await drain(channel);
    }
    const finalStart = sent.length;
    channel.client.send({ type: "prompt", content: "long job" });
    await drain(channel);

    for (const request of sent.slice(1)) {
        expect(request.systemPrompt).toBe(sent[0]?.systemPrompt);
        expect(JSON.stringify(request.tools)).toBe(JSON.stringify(sent[0]?.tools));
    }

    const finalRequests = sent.slice(finalStart);
    expect(finalRequests).toHaveLength(scenario.finalRounds + 1);
    let breaks = 0;
    for (let index = 1; index < finalRequests.length; index += 1) {
        if (!startsWith(
            finalRequests[index]!.messages,
            finalRequests[index - 1]!.messages,
        )) {
            breaks += 1;
        }
    }

    // Each limit may move the prefix once when the turn first passes it, and
    // once more for every further step the turn grows.
    const first = turnTail(finalRequests[0]!.messages);
    const last = turnTail(finalRequests[finalRequests.length - 1]!.messages);
    const tokenStep = WINDOW * TOKEN_TRIM_STEP_FRACTION;
    const byteStep = Math.floor(scenario.budgetBytes * BYTE_TRIM_STEP_FRACTION);
    const allowed = 2
        + Math.floor((measureMessages(last) - measureMessages(first)) / tokenStep)
        + Math.floor((toolResultBytes(last) - toolResultBytes(first)) / byteStep);

    // The turn ran above the threshold and trimmed, so a stable prefix is not
    // the result of trimming nothing.
    const gate = WINDOW
        * TOOL_RESULT_AGING_LEVELS[toolResultAgingLevel(WINDOW)].gateFraction;
    expect(measureMessages(store.unprojectedModelContext())).toBeGreaterThan(gate);
    const stored = new Map<string, string>();
    for (const message of store.messages()) {
        if (message.role === "tool_result") {
            stored.set(message.toolCallId, resultText(message));
        }
    }
    const trimmed = finalRequests[finalRequests.length - 1]!.messages.some(
        (message) => message.role === "tool_result"
            && stored.has(message.toolCallId)
            && resultText(message) !== stored.get(message.toolCallId),
    );
    expect(trimmed).toBe(true);

    return { breaks, allowed };
}

function startsWith(
    messages: readonly ModelInputMessage[],
    prefix: readonly ModelInputMessage[],
): boolean {
    return prefix.length <= messages.length
        && prefix.every((message, position) =>
            JSON.stringify(message) === JSON.stringify(messages[position])
        );
}

// Messages from the latest user prompt on. Trimming never touches these.
function turnTail(
    messages: readonly ModelInputMessage[],
): readonly ModelMessage[] {
    let start = 0;
    messages.forEach((message, index) => {
        if (message.role === "user" && message.internal !== true) start = index;
    });
    return messages.slice(start) as readonly ModelMessage[];
}

function toolResultBytes(messages: readonly ModelMessage[]): number {
    let bytes = 0;
    for (const message of messages) {
        if (message.role === "tool_result") {
            bytes += Buffer.byteLength(resultText(message), "utf8");
        }
    }
    return bytes;
}

function resultText(message: ModelInputMessage): string {
    if (message.role !== "tool_result") return "";
    return message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}

function writeNotes(
    workspace: string,
    name: string,
    seed: number,
    bytes: number,
): void {
    writeFileSync(join(workspace, name), notes(seed, bytes));
}

function notes(seed: number, bytes: number): string {
    const rows: string[] = [];
    let size = 0;
    for (let line = 1; size < bytes; line += 1) {
        const row = `${line}\tlog ${seed} line ${line}, a crow counts the doubloons\n`;
        rows.push(row);
        size += row.length;
    }
    return rows.join("");
}

function bashCall(id: string, path: string): AssistantMessage {
    return {
        role: "assistant",
        content: [
            { type: "text", text: `reading ${path}` },
            { type: "tool_call", id, name: "bash", input: { command: `cat ${path}` } },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function compactionOptions(
    trigger: SessionCompactionOptions["trigger"],
): SessionCompactionOptions {
    const summarizer: ModelAdapter = {
        stream(request) {
            return new FauxAdapter([
                assistantText("# Task\nRun the long job.\n\n# State\nRounds are running."),
            ]).stream(request);
        },
    };
    return {
        strategy: fullSummaryStrategy,
        models: {
            [FULL_SUMMARY_MODEL_SLOT]: createRoutedCompletionService(
                summarizer,
                { models: [{ provider: "faux", model: "test" }] },
            ),
        },
        diagnostics: {
            strategy: FULL_SUMMARY_STRATEGY_ID,
            provider: "faux",
            model: "test",
        },
        trigger,
    };
}

async function drain(
    channel: ReturnType<typeof createInProcessChannel>,
): Promise<readonly AgentUpdate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const updates: AgentUpdate[] = [];
    try {
        for (;;) {
            const update = await channel.client.receive(controller.signal);
            updates.push(update);
            if (update.type === "turn_finished") return updates;
        }
    } catch {
        // The timeout aborts the read; the assertions report what was missing.
    } finally {
        clearTimeout(timer);
    }
    return updates;
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-prefix-e2e-"));
    temporaryDirectories.push(directory);
    return directory;
}
