import { TOOL_RESULT_TOTAL_BUDGET_BYTES } from "../../src/engine/tool-result-history.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
    FULL_SUMMARY_STRATEGY_ID,
} from "../../src/engine/compaction-full-summary.ts";
import { createRoutedCompletionService } from
    "../../src/engine/completion-service.ts";
import type { SessionCompactionOptions } from "../../src/engine/run-turn.ts";
import { runSubagent } from "../../src/engine/subagent.ts";
import { assertToolCallsPaired } from "../../src/model/tool-pairing.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a long child turn compacts mid-turn and still returns its answer", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-subagent-compaction-"));
    temporaryDirectories.push(workspace);
    const sessionPath = join(workspace, "child.jsonl");

    const script: AssistantMessage[] = [];
    for (let round = 1; round <= 6; round += 1) {
        writeFileSync(
            join(workspace, `notes-${round}.txt`),
            `chunk ${round} `.repeat(6_000),
        );
        script.push(toolCall(`call-${round}`, round));
    }
    script.push(assistantText("the crow buried the gold"));

    const sent: ModelRequest[] = [];
    const faux = new FauxAdapter(script);
    const adapter: ModelAdapter = {
        stream(request) {
            sent.push(request);
            return faux.stream(request);
        },
    };
    let summarized = 0;

    const result = await runSubagent({
        adapter,
        model: "test",
        description: "Find where the crow hid the gold",
        workspace,
        approvalMode: "auto",
        sessionId: "child-compaction",
        sessionPath,
        contextLimit: 40_000,
        toolResults: { totalBudgetBytes: TOOL_RESULT_TOTAL_BUDGET_BYTES },
        compaction: compactionOptions(countingSummarizer(() => {
            summarized += 1;
        })),
    });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("the crow buried the gold");
    expect(summarized).toBeGreaterThan(0);

    for (const request of sent) {
        assertToolCallsPaired(
            request.messages as readonly ModelMessage[],
            "A sent request",
        );
    }
    expect(firstText(sent[sent.length - 1])).toContain(
        "summary of the earlier part",
    );

    const reopened = await SessionStore.open(sessionPath);
    expect(reopened.latestCompaction()).toBeDefined();
    assertToolCallsPaired(reopened.modelContext(), "The reopened context");
});

test("a child request over its own window is not sent when its compaction fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-subagent-window-"));
    temporaryDirectories.push(workspace);

    const sent: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            sent.push(request);
            return new FauxAdapter([assistantText("never sent")]).stream(request);
        },
    };

    const result = await runSubagent({
        adapter,
        model: "test",
        // The prompt alone is over this child's 20,000 token window, and no earlier turn exists to compact.
        description: "plank ".repeat(16_000),
        workspace,
        approvalMode: "auto",
        sessionId: "child-window",
        sessionPath: join(workspace, "child.jsonl"),
        contextLimit: 20_000,
        compaction: compactionOptions(unavailableSummarizer, 1_000_000),
    });

    expect(sent).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Compaction failed, so the request was not sent.");
});

function countingSummarizer(onSummarize: () => void): ModelAdapter {
    return {
        stream(request) {
            onSummarize();
            return new FauxAdapter([
                assistantText("# Task\nFind the gold.\n\n# State\nReading notes."),
            ]).stream(request);
        },
    };
}

const unavailableSummarizer: ModelAdapter = {
    stream() {
        throw new Error("summarizer unavailable");
    },
};

function compactionOptions(
    summarizer: ModelAdapter,
    triggerTokens = 24_000,
): SessionCompactionOptions {
    return {
        rungs: [{
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
        }],
        trigger: { tokens: triggerTokens },
    };
}

function toolCall(id: string, round: number): AssistantMessage {
    return {
        role: "assistant",
        content: [
            { type: "text", text: `round ${round}` },
            {
                type: "tool_call",
                id,
                name: "read",
                input: { path: `notes-${round}.txt` },
            },
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

function firstText(request: ModelRequest | undefined): string {
    const first = request?.messages[0];
    const block = first?.content[0];
    return block !== undefined && "text" in block ? block.text : "";
}
