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
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
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

test("the provider's own token count moves the trigger, not just the display", async () => {
    // Characters over four reads low against real tokenizers, and it does not
    // see reasoning or images at all. A session that measures itself only that
    // way passes the window while the trigger still believes there is room.
    const starts: number[] = [];
    for (const reported of [0, 20_000]) {
        const workspace = temporaryDirectory();
        const store = await SessionStore.create(
            join(workspace, "session.jsonl"),
            { sessionId: `loop-scale-${reported}`, cwd: workspace },
        );
        writeFileSync(join(workspace, "notes-1.txt"), "chunk ".repeat(1_500));

        const events = new EngineEventBus();
        const seen: EngineEvent[] = [];
        events.subscribe((event) => void seen.push(event));
        const channel = createInProcessChannel();
        void runHeadlessLoop(
            channel.engine,
            new FauxAdapter([
                reportingUsage(toolCall("scale-call-1", 1), reported),
                reportingUsage(assistantText("first done"), reported),
                reportingUsage(assistantText("second done"), reported),
            ]),
            "test",
            undefined,
            {
                sessionStore: store,
                eventBus: events,
                approvalMode: "auto",
                compaction: compactionOptions({ tokens: 8_000 }),
                readModelSettings: () => ({
                    model: "test",
                    contextWindow: 400_000,
                }),
                updateModelSettings: async () => undefined,
                readApprovalMode: () => "auto",
                updateApprovalMode: async () => undefined,
            },
        );

        channel.client.send({ type: "prompt", content: "first job" });
        await drain(channel);
        channel.client.send({ type: "prompt", content: "second job" });
        await drain(channel);
        starts.push(
            seen.filter((event) => event.type === "compaction_started").length,
        );
    }

    // The same transcript against the same trigger. The only difference is
    // what the provider said the request cost.
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThan(0);
});

/** A scripted answer that reports the request as costing more than the
 * estimator makes it. */
function reportingUsage(
    message: AssistantMessage,
    inputTokens: number,
): AssistantMessage {
    return { ...message, usage: { ...message.usage, inputTokens } };
}

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

test("a failed automatic compaction is attempted again once the context grows", async () => {
    // The latch stops the retry loop, and growth is the only thing that opens
    // it again. A new turn is not enough on its own: a parent waiting on
    // subagents takes turn after turn that adds nothing, and re-arming on each
    // one spends a summarizer call per turn to fail the same way. Growth says
    // the conditions are no longer the ones that failed.
    const { seen, channel } = await latchSession("loop-latch");

    channel.client.send({ type: "prompt", content: "first job" });
    await drain(channel);
    const afterFirst = started(seen);

    // Well past COMPACTION_RETRY_GROWTH_TOKENS, and in a user message, which
    // tool result aging cannot shrink back down.
    channel.client.send({ type: "prompt", content: "second job ".repeat(8_000) });
    await drain(channel);

    expect(afterFirst).toBeGreaterThan(0);
    expect(started(seen)).toBeGreaterThan(afterFirst);
});

test("a failed automatic compaction is not retried on a turn that adds nothing", async () => {
    // The other half of the same rule. Without growth the latch holds, and a
    // session that cannot compact stops paying for a call that will fail.
    const { seen, channel } = await latchSession("loop-latch-quiet");

    channel.client.send({ type: "prompt", content: "first job" });
    await drain(channel);
    const afterFirst = started(seen);

    channel.client.send({ type: "prompt", content: "ok" });
    await drain(channel);

    expect(afterFirst).toBeGreaterThan(0);
    expect(started(seen)).toBe(afterFirst);
});

test("an abort during an automatic compaction stops the compaction, not the turn", async () => {
    // The gesture belongs to the thing the user can see running. The turn is
    // parked on the compaction, so stopping the compaction lets it carry on
    // with the span it already has rather than losing the work as well.
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-cancel", cwd: workspace },
    );

    const script: AssistantMessage[] = [];
    for (let round = 1; round <= 3; round += 1) {
        writeFileSync(
            join(workspace, `notes-${round}.txt`),
            `chunk ${round} `.repeat(6_000),
        );
        script.push(toolCall(`cancel-call-${round}`, round));
    }
    script.push(assistantText("all done"));

    const agent = new FauxAdapter(script);
    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();

    // Sent from inside the summarizer call, so the abort is guaranteed to
    // arrive while a compaction is actually in flight.
    const compaction = cancellingCompactionOptions(
        () => channel.client.send({ type: "abort" }),
        { tokens: 20_000 },
    );

    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        sessionStore: store,
        eventBus: events,
        approvalMode: "auto",
        compaction,
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "do the long job" });
    const updates = await drain(channel);

    // The compaction stopped, and nothing it produced was applied.
    expect(seen.some((event) =>
        event.type === "compaction_finished"
        && "outcome" in event
        && event.outcome === "cancelled"
    )).toBe(true);
    expect(store.latestCompaction()).toBeUndefined();

    // And it stopped once. The context is still over the trigger, so without
    // the latch the next tool boundary opens another one and the user is
    // pressing escape every few seconds for the rest of the turn.
    expect(started(seen)).toBe(1);

    // And the turn it was running inside reached its end.
    expect(updates.some((update) => update.type === "turn_finished")).toBe(true);
    expect(store.messages().some((message) =>
        message.role === "assistant"
        && message.content.some((block) =>
            block.type === "text" && block.text.includes("all done")
        )
    )).toBe(true);
});

test("an abort with no compaction running still stops the turn", async () => {
    // The other half of the same rule: compaction takes the gesture only
    // while it holds it, and hands it straight back.
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-cancel-turn", cwd: workspace },
    );
    writeFileSync(join(workspace, "notes-1.txt"), "small ".repeat(10));

    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();

    // Aborts from inside the agent's own call, so no compaction is anywhere
    // near the window when the command lands.
    let calls = 0;
    const agent: ModelAdapter = {
        stream(request: ModelRequest) {
            calls += 1;
            const round = calls;
            if (round === 1) {
                channel.client.send({ type: "abort" });
            }
            return {
                [Symbol.asyncIterator]: async function* () {},
                result: async () => {
                    if (round > 1) {
                        return assistantText("second round");
                    }
                    await waitForAbort(request.signal);
                    return {
                        ...assistantText("stopped"),
                        stopReason: "aborted",
                    } as AssistantMessage;
                },
            };
        },
    } as unknown as ModelAdapter;

    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        sessionStore: store,
        eventBus: events,
        approvalMode: "auto",
        compaction: compactionOptions({ tokens: 20_000 }),
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "start something" });
    await drain(channel);

    expect(seen.some((event) => event.type === "abort_requested")).toBe(true);
    expect(started(seen)).toBe(0);
    // The turn stopped rather than being told to and carrying on: the second
    // scripted round never ran, so nothing asked the model again.
    expect(calls).toBe(1);
    expect(store.messages().some((message) =>
        message.role === "assistant"
        && message.content.some((block) =>
            block.type === "text" && block.text.includes("second round")
        )
    )).toBe(false);
});

test("a provider refusing the request for size reopens a latched compaction", async () => {
    // The latch waits for the estimate to grow. A refusal is the provider
    // saying that estimate was wrong, so waiting for it is waiting on a
    // number that has already lost its authority, and every later request is
    // refused for a reason the user cannot connect to anything they did.
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-refused", cwd: workspace },
    );
    writeFileSync(join(workspace, "notes-1.txt"), "chunk ".repeat(4_000));

    const faux = new FauxAdapter([
        toolCall("refused-call-1", 1),
        assistantText("first done"),
        assistantText("second done"),
    ]);
    // The call after the tool result is refused for size, which is the shape
    // a cancelled-but-needed compaction leaves behind.
    let calls = 0;
    const agent: ModelAdapter = {
        stream(request: ModelRequest) {
            calls += 1;
            if (calls !== 2) {
                return faux.stream(request);
            }
            const stream = new ModelEventStream();
            const error = new ProviderFailureError({
                kind: "request_too_large",
                resolution: "user_action",
                message: "prompt is too long",
            } as ProviderFailure, undefined);
            stream.push({ type: "start" });
            stream.push({
                type: "error",
                error,
                message: {
                    ...assistantText(""),
                    stopReason: "error",
                    errorMessage: error.message,
                } as AssistantMessage,
            });
            return stream;
        },
    } as unknown as ModelAdapter;

    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        sessionStore: store,
        eventBus: events,
        approvalMode: "auto",
        compaction: unavailableCompactionOptions({ tokens: 2_000 }),
        readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "first" });
    await drain(channel);
    // The summarizer is unreachable, so that attempt latched.
    expect(started(seen)).toBe(1);

    channel.client.send({ type: "prompt", content: "second" });
    await drain(channel);

    // Without the refusal the transcript has not grown by the margin the
    // latch waits for, so this second attempt only happens because the
    // provider overruled the estimate.
    expect(started(seen)).toBe(2);
});

test("a refusal under the trigger compacts anyway, and buys exactly one attempt", async () => {
    // Nothing is latched here. The estimate is under the trigger and the
    // provider has refused the request all the same, so the only number that
    // would ever have started a compaction is the one that just lost its
    // authority. Without this the session sends refused requests until an
    // estimate it should not believe finally crosses a line.
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "loop-refused-untriggered", cwd: workspace },
    );
    writeFileSync(join(workspace, "notes-1.txt"), "chunk ".repeat(200));

    const faux = new FauxAdapter([
        toolCall("under-call-1", 1),
        assistantText("first done"),
        assistantText("second done"),
        assistantText("third done"),
    ]);
    let calls = 0;
    const agent: ModelAdapter = {
        stream(request: ModelRequest) {
            calls += 1;
            if (calls !== 2) {
                return faux.stream(request);
            }
            const stream = new ModelEventStream();
            const error = new ProviderFailureError({
                kind: "request_too_large",
                resolution: "user_action",
                message: "prompt is too long",
            } as ProviderFailure, undefined);
            stream.push({ type: "start" });
            stream.push({
                type: "error",
                error,
                message: {
                    ...assistantText(""),
                    stopReason: "error",
                    errorMessage: error.message,
                } as AssistantMessage,
            });
            return stream;
        },
    } as unknown as ModelAdapter;

    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        sessionStore: store,
        eventBus: events,
        approvalMode: "auto",
        // Far above anything this session will reach, so the trigger alone
        // never fires and every compaction here is the refusal's doing.
        compaction: compactionOptions({ tokens: 5_000_000 }),
        readModelSettings: () => ({ model: "test", contextWindow: 8_000_000 }),
        updateModelSettings: async () => undefined,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
    });

    channel.client.send({ type: "prompt", content: "first" });
    await drain(channel);
    expect(started(seen)).toBe(0);

    channel.client.send({ type: "prompt", content: "second" });
    await drain(channel);
    expect(started(seen)).toBe(1);

    // And the refusal is spent. It bought that attempt; left set it would buy
    // another one later, against a session nothing has refused since.
    channel.client.send({ type: "prompt", content: "third" });
    await drain(channel);
    expect(started(seen)).toBe(1);
});

function cancellingCompactionOptions(
    onCall: () => void,
    trigger?: SessionCompactionOptions["trigger"],
): SessionCompactionOptions {
    const summarizer: ModelAdapter = {
        stream(request: ModelRequest) {
            return {
                [Symbol.asyncIterator]: async function* () {},
                result: async () => {
                    onCall();
                    await waitForAbort(request.signal);
                    // Answered anyway, which is the case the check exists
                    // for: a summary already paid for is still not applied
                    // to a session that asked to be left alone.
                    return assistantText(
                        "# Task\nRun the long job.\n\n# State\nRunning.",
                    );
                },
            };
        },
    } as unknown as ModelAdapter;
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

async function latchSession(sessionId: string): Promise<{
    seen: EngineEvent[];
    channel: ReturnType<typeof createInProcessChannel>;
}> {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId, cwd: workspace },
    );
    writeFileSync(join(workspace, "notes-1.txt"), "chunk ".repeat(4_000));
    const script: AssistantMessage[] = [
        toolCall("latch-call-1", 1),
        assistantText("first done"),
        assistantText("second done"),
    ];
    const events = new EngineEventBus();
    const seen: EngineEvent[] = [];
    events.subscribe((event) => void seen.push(event));
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter(script),
        "test",
        undefined,
        {
            sessionStore: store,
            eventBus: events,
            approvalMode: "auto",
            compaction: unavailableCompactionOptions({ tokens: 2_000 }),
            readModelSettings: () => ({ model: "test", contextWindow: 40_000 }),
            updateModelSettings: async () => undefined,
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
        },
    );
    return { seen, channel };
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
