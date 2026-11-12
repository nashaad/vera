import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    BUNDLED_COMPACTION_STRATEGIES,
    bindCompaction,
} from "../../src/engine/compaction-binding.ts";
import { createCompactionController } from "../../src/engine/compaction-controller.ts";
import {
    DROP_OLDEST_STRATEGY_ID,
    dropOldestStrategy,
} from "../../src/engine/compaction-drop-oldest.ts";
import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
    FULL_SUMMARY_STRATEGY_ID,
} from "../../src/engine/compaction-full-summary.ts";
import { createRoutedCompletionService } from "../../src/engine/completion-service.ts";
import { measureMessages } from "../../src/engine/context-measurement.ts";
import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import {
    createInProcessChannel,
    type InProcessChannel,
} from "../../src/engine/message-channel.ts";
import {
    runHeadlessLoop,
    type SessionCompactionOptions,
    type SessionCompactionRung,
} from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelMessage,
    type ModelReasoningEffort,
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

// A 20,000 token window has a 9,000 token compaction target.
const WINDOW = 20_000;

test("a summary that stops at the length limit hands over to drop-oldest in the same pass", async () => {
    const calls = { count: 0 };
    const { seen, sent } = await windowHandover(
        "window-length",
        scriptedSummarizer(truncatedSummary, calls),
    );

    expect(calls.count).toBe(1);
    expect(compactionOutcomes(seen)).toEqual(["unavailable", "compacted"]);
    expect(started(seen)).toBe(2);
    const landed = landedAfter(seen);
    expect(landed).toHaveLength(1);
    expect(landed.every((size) => size <= WINDOW)).toBe(true);

    expect(sent).toHaveLength(2);
    const last = sent.at(-1);
    expect(firstText(last)).toBe("second");
    expect(JSON.stringify(last?.messages ?? [])).not.toContain("earlier reply");
    expect(turnEnd(seen)?.stopReason).toBe("stop");
});

test("every rung failing at the window stops the turn with the error and sends nothing over the window", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-stop", cwd: workspace },
    );
    const { agent, sent } = recordingAgent([assistantText("first done")]);
    const seen: EngineEvent[] = [];
    const channel = createInProcessChannel();
    startLoop(store, agent, seen, channel, {
        rungs: [summaryRung(unavailableSummarizer), dropOldestRung],
    }, WINDOW);

    channel.client.send({ type: "prompt", content: "first" });
    await drainTurn(channel);
    // 28,000 tokens of prompt, more than the 9,000 token target can hold.
    channel.client.send({ type: "prompt", content: "pasted ".repeat(16_000) });
    await drainTurn(channel);

    expect(compactionOutcomes(seen)).toEqual(["unavailable", "rejected"]);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent.map((request) => request.messages))).not.toContain(
        "pasted ",
    );
    for (const request of sent) {
        expect(
            measureMessages(request.messages as readonly ModelMessage[]),
        ).toBeLessThanOrEqual(WINDOW);
    }

    const end = turnEnd(seen);
    expect(end?.stopReason).toBe("error");
    expect(end?.errorMessage).toBe(
        "Compaction failed, so the request was not sent. "
            + `${FULL_SUMMARY_STRATEGY_ID}: The model route produced no answer `
            + "(test failed: summarizer unavailable). "
            + `${DROP_OLDEST_STRATEGY_ID}: The newest turn's prompt and newest step do not fit the target.`,
    );
});

test("a failed compaction between the trigger and the window lets the turn continue", async () => {
    const workspace = temporaryDirectory();
    // About 6,000 tokens once read: above the 2,000 token trigger, far below the window.
    writeFileSync(join(workspace, "notes-1.txt"), "chunk ".repeat(4_000));
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-between", cwd: workspace },
    );
    const { agent, sent } = recordingAgent([
        toolCall("between-call-1", 1),
        assistantText("finished without the summary"),
    ]);
    const seen: EngineEvent[] = [];
    const channel = createInProcessChannel();
    startLoop(store, agent, seen, channel, {
        rungs: [summaryRung(unavailableSummarizer)],
        trigger: { tokens: 2_000 },
    }, 40_000);

    channel.client.send({ type: "prompt", content: "read the notes" });
    await drainTurn(channel);

    expect(started(seen)).toBe(1);
    expect(compactionOutcomes(seen)).toEqual(["unavailable"]);
    expect(sent).toHaveLength(2);
    expect(turnEnd(seen)?.stopReason).toBe("stop");
});

test("a request held at the window leaves no latch, so the next automatic check runs", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-no-latch", cwd: workspace },
    );
    await store.appendMessage(userText("first"));
    await store.appendMessage(assistantText("first done"));
    await store.appendMessage(userText("second"));
    await store.appendMessage(assistantText("second done"));

    const seen: EngineEvent[] = [];
    const events = new EngineEventBus();
    events.subscribe((event) => void seen.push(event));
    const controller = createCompactionController({
        store,
        model: "test",
        scratchDir: workspace,
        events,
        readCompaction: () => ({ rungs: [summaryRung(unavailableSummarizer)] }),
        readToolResults: () => undefined,
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        inbound: {
            beginAutomaticCompaction: () => undefined,
            endAutomaticCompaction: () => undefined,
        },
        afterCompacted: async () => false,
    });
    const signal = new AbortController().signal;

    // Over the 40,000 token window: the check runs the ladder, and the ladder fails.
    controller.contextWatch.overheadTokens = 45_000;
    const stop = await controller.enforceWindow(signal);
    expect(stop?.outcome).toBe("failed");
    expect(started(seen)).toBe(1);

    // Between the 32,800 token trigger and the window: the automatic check still runs.
    controller.contextWatch.overheadTokens = 35_000;
    await controller.compact(signal);
    expect(started(seen)).toBe(2);
});

test("a compaction that lands and still measures over the window stops the request with the still-over message", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-still-over", cwd: workspace },
    );
    await store.appendMessage(userText("first"));
    await store.appendMessage(assistantText("earlier reply ".repeat(8_000)));
    await store.appendMessage(userText("second"));
    await store.appendMessage(assistantText("second done"));

    const seen: EngineEvent[] = [];
    const events = new EngineEventBus();
    events.subscribe((event) => void seen.push(event));
    const controller = createCompactionController({
        store,
        model: "test",
        scratchDir: workspace,
        events,
        readCompaction: () => ({
            rungs: [summaryRung(scriptedSummarizer(
                () => assistantText("# Task\nRun the long job."),
                { count: 0 },
            ))],
        }),
        readToolResults: () => undefined,
        readModelSettings: () => ({ model: "test", contextWindow: WINDOW }),
        inbound: {
            beginAutomaticCompaction: () => undefined,
            endAutomaticCompaction: () => undefined,
        },
        // The context restored after landing is larger than the window, so the refreshed size is over it.
        afterCompacted: async () => {
            await store.appendMessage(userText("restored ".repeat(16_000)));
            return true;
        },
    });
    controller.contextWatch.overheadTokens = 3_000;

    const stop = await controller.enforceWindow(new AbortController().signal);
    expect(stop).toEqual({
        outcome: "failed",
        message: "Compaction ran, but the context is still over the context limit, so the request was not sent.",
    });
    expect(compactionOutcomes(seen)).toEqual(["compacted"]);
});

test("an abort while the window check compacts ends the turn as aborted and sends nothing", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-abort", cwd: workspace },
    );
    const { agent, sent } = recordingAgent([assistantText("first done")]);
    const seen: EngineEvent[] = [];
    const channel = createInProcessChannel();
    startLoop(store, agent, seen, channel, {
        rungs: [
            summaryRung(abortingSummarizer(() => {
                channel.client.send({ type: "abort" });
            })),
            dropOldestRung,
        ],
    }, WINDOW);

    channel.client.send({ type: "prompt", content: "first" });
    await drainTurn(channel);
    channel.client.send({ type: "prompt", content: "pasted ".repeat(16_000) });
    await drainTurn(channel);

    expect(compactionOutcomes(seen)).toEqual(["cancelled"]);
    expect(sent).toHaveLength(1);
    expect(turnEnd(seen)?.stopReason).toBe("aborted");
});

test("a request over the window with no compaction bound stops with the unbound message", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-unbound", cwd: workspace },
    );
    const { agent, sent } = recordingAgent([assistantText("never sent")]);
    const seen: EngineEvent[] = [];
    const channel = createInProcessChannel();
    startLoop(store, agent, seen, channel, undefined, WINDOW);

    channel.client.send({ type: "prompt", content: "x".repeat(100_000) });
    await drainTurn(channel);

    expect(sent).toHaveLength(0);
    expect(turnEnd(seen)?.errorMessage).toBe(
        "Compaction could not run, so the request was not sent. No compaction strategy is bound for this session.",
    );
});

test("a drop-oldest landing persists, and a reopened session projects the same context", async () => {
    const { store } = await windowHandover(
        "window-persist",
        scriptedSummarizer(truncatedSummary, { count: 0 }),
    );

    const reopened = await SessionStore.open(store.path);
    expect(reopened.latestCompaction()).toBeDefined();
    expect(reopened.latestCompaction()?.id).toBe(store.latestCompaction()?.id);
    expect(JSON.stringify(reopened.modelContext())).toBe(
        JSON.stringify(store.modelContext()),
    );
    expect(JSON.stringify(reopened.modelContext())).not.toContain("earlier reply");

    const prompts = reopened.modelContext().filter((message) =>
        message.role === "user"
        && message.content.some((block) =>
            block.type === "text" && block.text === "second"
        )
    );
    expect(prompts).toHaveLength(1);
});

test("with no known window the hard check does not run, so an over-large request is sent and no rung runs", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-unknown", cwd: workspace },
    );
    const { agent, sent } = recordingAgent([
        assistantText("sent without a window"),
    ]);
    const seen: EngineEvent[] = [];
    const calls = { count: 0 };
    const channel = createInProcessChannel();
    startLoop(store, agent, seen, channel, {
        rungs: [
            summaryRung(scriptedSummarizer(truncatedSummary, calls)),
            dropOldestRung,
        ],
    }, undefined);

    // About 28,000 tokens, above WINDOW. No window is declared, so the request
    // stays under the 100,000 token trigger that applies without one.
    channel.client.send({ type: "prompt", content: "pasted ".repeat(16_000) });
    await drainTurn(channel);

    expect(sent).toHaveLength(1);
    for (const request of sent) {
        expect(
            measureMessages(request.messages as readonly ModelMessage[]),
        ).toBeGreaterThan(WINDOW);
    }
    expect(started(seen)).toBe(0);
    expect(calls.count).toBe(0);
    expect(turnEnd(seen)?.stopReason).toBe("stop");
});

test("a rung's effort reaches its summary call, and the turn's own request keeps the session's effort", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "window-effort", cwd: workspace },
    );
    const efforts: (string | undefined)[] = [];
    const summarizer: ModelAdapter = {
        stream(request) {
            efforts.push(request.reasoningEffort);
            return new FauxAdapter([
                assistantText("# Task\nRun the long job."),
            ]).stream(request);
        },
    };
    const compaction = bindCompaction(
        {
            ladder: [{
                strategy: FULL_SUMMARY_STRATEGY_ID,
                routes: {},
                slots: {
                    [FULL_SUMMARY_MODEL_SLOT]: [{
                        name: "small",
                        provider: "faux",
                        model: "summary-test",
                    }],
                },
                reasoning_effort: "low",
            }],
        },
        summarizer,
        undefined,
        BUNDLED_COMPACTION_STRATEGIES,
    );
    const { agent, sent } = recordingAgent([
        assistantText("earlier reply ".repeat(8_000)),
        assistantText("second done"),
    ]);
    const seen: EngineEvent[] = [];
    const channel = createInProcessChannel();
    startLoop(store, agent, seen, channel, compaction, WINDOW, "high");

    channel.client.send({ type: "prompt", content: "first" });
    await drainTurn(channel);
    channel.client.send({ type: "prompt", content: "second" });
    await drainTurn(channel);

    expect(compactionOutcomes(seen)).toEqual(["compacted"]);
    expect(efforts).toEqual(["low"]);
    expect(sent.map((request) => request.reasoningEffort)).toEqual([
        "high",
        "high",
    ]);
});

// Turn one's reply is larger than the window, so the context is over the window when turn two starts.
async function windowHandover(
    sessionId: string,
    summarizer: ModelAdapter,
): Promise<{
    store: SessionStore;
    seen: EngineEvent[];
    sent: ModelRequest[];
}> {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId, cwd: workspace },
    );
    const { agent, sent } = recordingAgent([
        assistantText("earlier reply ".repeat(8_000)),
        assistantText("second done"),
    ]);
    const seen: EngineEvent[] = [];
    const channel = createInProcessChannel();
    startLoop(store, agent, seen, channel, {
        rungs: [summaryRung(summarizer), dropOldestRung],
    }, WINDOW);

    channel.client.send({ type: "prompt", content: "first" });
    await drainTurn(channel);
    channel.client.send({ type: "prompt", content: "second" });
    await drainTurn(channel);
    return { store, seen, sent };
}

function recordingAgent(script: AssistantMessage[]): {
    agent: ModelAdapter;
    sent: ModelRequest[];
} {
    const sent: ModelRequest[] = [];
    const faux = new FauxAdapter(script);
    return {
        sent,
        agent: {
            stream(request) {
                sent.push(request);
                return faux.stream(request);
            },
        },
    };
}

function startLoop(
    store: SessionStore,
    agent: ModelAdapter,
    seen: EngineEvent[],
    channel: InProcessChannel,
    compaction: SessionCompactionOptions | undefined,
    contextWindow: number | undefined,
    reasoningEffort?: ModelReasoningEffort,
): void {
    const events = new EngineEventBus();
    events.subscribe((event) => void seen.push(event));
    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        approvalMode: "auto",
    },
    {
        sessionStore: store,
        eventBus: events,
        ...(compaction === undefined ? {} : { compaction }),
        readModelSettings: () => ({
            model: "test",
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: {
            updateModelSettings: async () => undefined,
        },
    });
}

function summaryRung(summarizer: ModelAdapter): SessionCompactionRung {
    return {
        strategy: fullSummaryStrategy,
        models: {
            [FULL_SUMMARY_MODEL_SLOT]: createRoutedCompletionService(summarizer, {
                models: [{ provider: "faux", model: "test" }],
            }),
        },
        diagnostics: {
            strategy: FULL_SUMMARY_STRATEGY_ID,
            provider: "faux",
            model: "test",
        },
    };
}

const dropOldestRung: SessionCompactionRung = {
    strategy: dropOldestStrategy,
    models: {},
};

const unavailableSummarizer: ModelAdapter = {
    stream() {
        throw new Error("summarizer unavailable");
    },
};

function scriptedSummarizer(
    reply: () => AssistantMessage,
    calls: { count: number },
): ModelAdapter {
    return {
        stream(request) {
            calls.count += 1;
            return new FauxAdapter([reply()]).stream(request);
        },
    };
}

// A summary that stops at the length limit, as a summarizer with too small a limit does.
function truncatedSummary(): AssistantMessage {
    return {
        ...assistantText("# Task\nRun the long job."),
        stopReason: "length",
    };
}

// Calls onCall from result(), then answers only once the request is aborted.
function abortingSummarizer(onCall: () => void): ModelAdapter {
    return {
        stream(request: ModelRequest) {
            return {
                [Symbol.asyncIterator]: async function* () {},
                result: async () => {
                    onCall();
                    await waitForAbort(request.signal);
                    return assistantText("# Task\nRun the long job.");
                },
            };
        },
    } as unknown as ModelAdapter;
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined || signal.aborted) {
        return;
    }
    await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

function started(seen: readonly EngineEvent[]): number {
    return seen.filter((event) => event.type === "compaction_started").length;
}

function compactionOutcomes(seen: readonly EngineEvent[]): string[] {
    return seen.flatMap((event) =>
        event.type === "compaction_finished" ? [event.outcome] : []
    );
}

function landedAfter(seen: readonly EngineEvent[]): number[] {
    return seen.flatMap((event) =>
        event.type === "compaction_finished"
            && event.outcome === "compacted"
            && event.after !== undefined
            ? [event.after]
            : []
    );
}

function turnEnd(seen: readonly EngineEvent[]): AssistantMessage | undefined {
    return seen.flatMap((event) =>
        event.type === "turn_finished" ? [event.message] : []
    ).at(-1);
}

function firstText(request: ModelRequest | undefined): string {
    const block = request?.messages[0]?.content[0];
    return block !== undefined && block.type === "text" ? block.text : "";
}

function userText(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
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

// Reads updates until the turn finishes. A timeout ends the wait, and the assertions report what did not arrive.
async function drainTurn(channel: InProcessChannel): Promise<void> {
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
        // Aborted by the timeout.
    } finally {
        clearTimeout(timer);
    }
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-window-e2e-"));
    temporaryDirectories.push(directory);
    return directory;
}
