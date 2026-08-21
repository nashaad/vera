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
import { measureMessages } from "../../src/engine/context-measurement.ts";
import {
    runHeadlessLoop,
    type SessionCompactionOptions,
} from "../../src/engine/run-turn.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
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
        compaction: compactionOptions({ tokens: 24_000 }),
        // Small enough that a few rounds of reading overflow it, but still
        // wide enough that the post-compaction target clears the fixed request
        // overhead of a real system prompt and tool set.
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "do the long job" });
    const updates = await drain(channel);

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

    const compacted = updates.find((update): update is Extract<
        AgentUpdate,
        { readonly type: "compaction" }
    > =>
        update.type === "compaction"
        && update.phase === "finished"
        && update.outcome === "compacted"
    );
    expect(compacted).toBeDefined();
    const refreshed = updates.find((update, index) =>
        index > updates.indexOf(compacted!) && update.type === "context"
    );
    expect(refreshed).toMatchObject({
        type: "context",
        measurement: {
            tokens: compacted?.after,
            capacity: 40_000,
            estimated: true,
            compaction: { triggerFraction: 0.82 },
        },
    });

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

test("an unavailable automatic compaction is not retried at every tool boundary", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-unavailable", cwd: workspace },
    );

    const script: AssistantMessage[] = [];
    for (let round = 1; round <= 3; round += 1) {
        writeFileSync(
            join(workspace, `notes-${round}.txt`),
            `chunk ${round} `.repeat(6_000),
        );
        script.push(toolCall(`unavailable-call-${round}`, round));
    }
    script.push(assistantText("finished despite the failed compaction"));

    const agent = new FauxAdapter(script);
    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        sessionStore: store,
        eventBus: events,
        approvalMode: "auto",
        compaction: unavailableCompactionOptions({ tokens: 20_000 }),
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "do the long job" });
    await drain(channel);

    const starts = seen.filter((event) => event.type === "compaction_started");
    expect(starts).toHaveLength(1);
});

test("a pre-turn no-boundary result gets one retry after the prompt is durable", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-no-boundary", cwd: workspace },
    );
    writeFileSync(
        join(workspace, "notes-1.txt"),
        "useful output ".repeat(6_000),
    );

    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, new FauxAdapter([
        toolCall("retry-call", 1),
        assistantText("finished after the boundary appeared"),
    ]), "test", undefined, {
        sessionStore: store,
        eventBus: events,
        approvalMode: "auto",
        compaction: compactionOptions({ tokens: 1 }),
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "create a boundary" });
    await drain(channel);

    const finished = seen.filter((event) =>
        event.type === "compaction_finished"
    );
    expect(finished.some((event) =>
        "outcome" in event && event.outcome === "no_boundary"
    )).toBe(true);
    expect(finished.some((event) =>
        "outcome" in event && event.outcome === "compacted"
    )).toBe(true);
});

test("aged tool results below the trigger do not trigger compaction from their durable bytes", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-aged-results", cwd: workspace },
    );

    for (let turn = 1; turn <= 8; turn += 1) {
        const output = `output ${turn} `.repeat(3_000);
        const spillPath = join(workspace, `spill-${turn}.txt`);
        writeFileSync(spillPath, output);
        const callId = `aged-call-${turn}`;
        await store.appendMessage({
            role: "user",
            content: [{ type: "text", text: `turn ${turn}` }],
        });
        await store.appendMessage(toolCall(callId, turn));
        await store.appendMessage({
            role: "tool_result",
            toolCallId: callId,
            toolName: "read",
            content: [{ type: "text", text: output }],
            isError: false,
            toolResultSource: {
                originalBytes: Buffer.byteLength(output),
                spillPath,
            },
        });
    }

    expect(measureMessages(store.unprojectedModelContext()))
        .toBeGreaterThan(40_000 * 0.82);
    expect(measureMessages(store.modelContext()))
        .toBeLessThan(40_000 * 0.82);

    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([assistantText("done")]),
        "test",
        undefined,
        {
            sessionStore: store,
            eventBus: events,
            approvalMode: "auto",
            compaction: compactionOptions(),
            readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
            updateModelSettings: async () => undefined,
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
        },
    );

    channel.client.send({ type: "prompt", content: "continue" });
    await drain(channel);

    expect(seen.filter((event) => event.type === "compaction_started"))
        .toHaveLength(0);
});

function compactionOptions(
    trigger?: SessionCompactionOptions["trigger"],
): SessionCompactionOptions {
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
        ...(trigger === undefined ? {} : { trigger }),
    };
}

function unavailableCompactionOptions(
    trigger?: SessionCompactionOptions["trigger"],
): SessionCompactionOptions {
    return {
        strategy: fullSummaryStrategy,
        models: {
            [FULL_SUMMARY_MODEL_SLOT]: createRoutedCompletionService(
                {
                    stream() {
                        throw new Error("summarizer unavailable");
                    },
                },
                { models: [{ provider: "faux", model: "unavailable" }] },
            ),
        },
        ...(trigger === undefined ? {} : { trigger }),
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
): Promise<readonly AgentUpdate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const updates: AgentUpdate[] = [];
    try {
        for (;;) {
            const update = await channel.client.receive(controller.signal);
            updates.push(update);
            if (update.type === "turn_finished") {
                return updates;
            }
        }
    } catch {
        // Aborted by the timeout, which the assertions then report on.
    } finally {
        clearTimeout(timer);
    }
    return updates;
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-loop-e2e-"));
    temporaryDirectories.push(directory);
    return directory;
}
