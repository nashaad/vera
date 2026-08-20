import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
} from "../../src/engine/compaction-full-summary.ts";
import { createRoutedCompletionService } from
    "../../src/engine/completion-service.ts";
import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { createInProcessChannel } from
    "../../src/engine/message-channel.ts";
import {
    runHeadlessLoop,
    type SessionCompactionOptions,
} from "../../src/engine/run-turn.ts";
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

/**
 * The loop end to end. A scripted agent runs a long tool turn against a window
 * too small to hold it, so compaction has to fire during the turn and the
 * ladder has to find a seam inside it. Everything but the models is real: the
 * engine loop, the tools, the strategy, and the session on disk.
 */

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a long tool turn compacts mid-turn and keeps running", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-1", cwd: workspace },
    );

    // Six tool rounds, each reading enough to push the window over.
    const script: AssistantMessage[] = [];
    for (let round = 1; round <= 6; round += 1) {
        writeFileSync(
            join(workspace, `notes-${round}.txt`),
            `chunk ${round} `.repeat(6_000),
        );
        script.push(toolCall(`call-${round}`, round));
    }
    script.push(assistantText("all done"));

    const sent: ModelRequest[] = [];
    const agent: ModelAdapter = {
        stream(request) {
            sent.push(request);
            return faux.stream(request);
        },
    };
    const faux = new FauxAdapter(script);

    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));

    const channel = createInProcessChannel();
    // The loop runs until the process ends, so it is started, not awaited.
    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        sessionStore: store,
        eventBus: events,
        approvalMode: "auto",
        compaction: compactionOptions(),
        // Small enough that a few rounds of reading overflow it, but still
        // wide enough that the post-compaction target clears the fixed request
        // overhead of a real system prompt and tool set.
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "do the long job" });
    await drain(channel);

    const finished = seen.filter((event) =>
        event.type === "compaction_finished"
    );
    // It fired, and it landed, which is the whole defect: it used to decline.
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.some((event) =>
        "outcome" in event && event.outcome === "compacted"
    )).toBe(true);
    expect(finished.every((event) =>
        !("outcome" in event) || event.outcome !== "no_boundary"
    )).toBe(true);

    // The turn still finished after being compacted underneath.
    expect(store.messages().some((message) =>
        message.role === "assistant"
        && message.content.some((block) =>
            block.type === "text" && block.text.includes("all done")
        )
    )).toBe(true);

    // Every request the agent made was a legal one.
    for (const request of sent) {
        // A request carries the wider input message type; the pairing check
        // reads only roles and tool IDs, which both shapes share.
        assertToolCallsPaired(
            request.messages as readonly ModelMessage[],
            "A sent request",
        );
        expect(request.messages[0]?.role).not.toBe("tool_result");
    }

    // The last request opened on the summary, so the compaction reached the
    // model rather than only the store.
    const last = sent[sent.length - 1];
    expect(firstText(last)).toContain("summary of the earlier part");

    const reopened = await SessionStore.open(store.path);
    expect(reopened.latestCompaction()).toBeDefined();
    assertToolCallsPaired(reopened.modelContext(), "The reopened context");
});

function compactionOptions(): SessionCompactionOptions {
    const summarizer: ModelAdapter = {
        stream(request) {
            return new FauxAdapter([
                assistantText(
                    "# Task\nRun the long job.\n\n# State\nRounds are running.",
                ),
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
                // Each round pulls tens of thousands of characters back.
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
    const block = request?.messages[0]?.content[0];
    return block !== undefined && block.type === "text" ? block.text : "";
}

/** Reads updates until the turn ends, whatever it ends as. */
async function drain(
    channel: ReturnType<typeof createInProcessChannel>,
): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
        for (;;) {
            const update = await channel.client.receive(controller.signal);
            if (update.type === "turn_finished") {
                return;
            }
        }
    } catch {
        // Aborted by the timeout, which the assertions then report on.
    } finally {
        clearTimeout(timer);
    }
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-loop-e2e-"));
    temporaryDirectories.push(directory);
    return directory;
}
