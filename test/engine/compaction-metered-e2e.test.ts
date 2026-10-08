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
import { EngineEventBus } from "../../src/engine/events.ts";
import { createInProcessChannel } from
    "../../src/engine/message-channel.ts";
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

// One long tool turn against a provider that bills what it was sent, including
// signed reasoning replayed to the model that produced it.

const WINDOW = 80_000;
const ROUNDS = 40;

interface Provider {
    readonly charactersPerToken: number;
    readonly reasoningPerCall: number;
}

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

type Mark =
    | { readonly kind: "request"; readonly billed: number; readonly meter?: number }
    | { readonly kind: "compaction"; readonly outcome?: string };

test("compaction tracks the bill when replayed reasoning is most of it", async () => {
    await runMeteredTurn({ charactersPerToken: 3.5, reasoningPerCall: 1_500 });
});

test("compaction tracks the bill when the tokenizer is much denser than the estimate", async () => {
    await runMeteredTurn({ charactersPerToken: 2, reasoningPerCall: 0 });
});

test("a new model starts from its own estimate, not the last model's correction", async () => {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "metered-switch", cwd: workspace },
    );
    const script: AssistantMessage[] = [];
    for (let round = 1; round <= 4; round += 1) {
        writeFileSync(
            join(workspace, `log-${round}.txt`),
            `the crow counts doubloons ${round} `.repeat(200),
        );
        script.push(reasoningToolCall(round, 0));
        if (round === 2) script.push(finalAnswer("half the hoard counted"));
    }
    script.push(finalAnswer("all doubloons counted"));

    const charactersPerToken: Record<string, number> = { luna: 2, kestrel: 4 };
    let current = "luna";
    let meter: number | undefined;
    const requests: { model: string; billed: number; meter?: number }[] = [];
    const agent: ModelAdapter = {
        stream(request) {
            const billed = bill(request, charactersPerToken[request.model] ?? 4);
            requests.push({
                model: request.model,
                billed,
                ...(meter === undefined ? {} : { meter }),
            });
            const next = script.shift();
            if (next === undefined) {
                throw new Error("The script ran out");
            }
            return new FauxAdapter([{
                ...next,
                usage: { ...next.usage, inputTokens: billed },
            }]).stream(request);
        },
    };
    const events = new EngineEventBus();
    events.subscribe((event) => {
        if (event.type === "context_measured") {
            meter = event.measurement.tokens;
        }
    });

    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "luna", undefined, {
        approvalMode: "auto",
    }, {
        sessionStore: store,
        eventBus: events,
        compaction: compactionOptions(),
        readModelSettings: () => ({ model: current, contextWindow: WINDOW }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: { updateModelSettings: async () => undefined },
    });
    channel.client.send({ type: "prompt", content: "count half the doubloons" });
    await drain(channel);
    current = "kestrel";
    channel.client.send({ type: "prompt", content: "count the rest" });
    await drain(channel);

    expect(requests.map((request) => request.model)).toEqual([
        "luna", "luna", "luna", "kestrel", "kestrel", "kestrel",
    ]);
    for (const [index, request] of requests.entries()) {
        if (index === 0 || request.meter === undefined) continue;
        expect(Math.abs(request.meter - request.billed) / request.billed)
            .toBeLessThan(0.2);
    }
});

async function runMeteredTurn(provider: Provider): Promise<void> {
    const workspace = temporaryDirectory();
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "metered", cwd: workspace },
    );
    const script: AssistantMessage[] = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
        writeFileSync(
            join(workspace, `log-${round}.txt`),
            `the crow counts doubloons ${round} `.repeat(200),
        );
        script.push(reasoningToolCall(round, provider.reasoningPerCall));
    }
    script.push(finalAnswer("all doubloons counted"));

    const timeline: Mark[] = [];
    let meter: number | undefined;
    const sent: ModelRequest[] = [];
    const agent: ModelAdapter = {
        stream(request) {
            sent.push(request);
            const billed = bill(request, provider.charactersPerToken);
            timeline.push({
                kind: "request",
                billed,
                ...(meter === undefined ? {} : { meter }),
            });
            const next = script.shift();
            if (next === undefined) {
                throw new Error("The script ran out");
            }
            return new FauxAdapter([{
                ...next,
                usage: { ...next.usage, inputTokens: billed },
            }]).stream(request);
        },
    };

    const events = new EngineEventBus();
    events.subscribe((event) => {
        if (event.type === "context_measured") {
            meter = event.measurement.tokens;
        }
        if (event.type === "compaction_finished") {
            timeline.push({ kind: "compaction", outcome: event.outcome });
        }
    });

    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "luna", undefined, {
        approvalMode: "auto",
    }, {
        sessionStore: store,
        eventBus: events,
        compaction: compactionOptions(),
        readModelSettings: () => ({ model: "luna", contextWindow: WINDOW }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: { updateModelSettings: async () => undefined },
    });
    channel.client.send({ type: "prompt", content: "count every doubloon" });
    await drain(channel);

    const requests = timeline.filter((mark): mark is Extract<Mark, { kind: "request" }> =>
        mark.kind === "request"
    );
    expect(requests).toHaveLength(ROUNDS + 1);
    expect(store.messages().some((message) =>
        message.role === "assistant"
        && message.content.some((block) =>
            block.type === "text" && block.text === "all doubloons counted"
        )
    )).toBe(true);

    const compactions = timeline.filter((mark) => mark.kind === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions.every((mark) =>
        mark.kind === "compaction" && mark.outcome === "compacted"
    )).toBe(true);

    for (const [index, request] of requests.entries()) {
        expect(request.billed).toBeLessThan(WINDOW);
        // The first request has no bill to correct against yet.
        if (index > 0 && request.meter !== undefined) {
            expect(Math.abs(request.meter - request.billed) / request.billed)
                .toBeLessThan(0.2);
        }
    }

    for (const [index, mark] of timeline.entries()) {
        if (mark.kind !== "compaction") continue;
        const before = lastRequestBefore(timeline, index);
        const after = firstRequestAfter(timeline, index);
        expect(before?.billed ?? 0).toBeGreaterThan(WINDOW * 0.7);
        expect(after?.billed ?? WINDOW).toBeLessThan(WINDOW * 0.6);
        const nextCompaction = timeline.findIndex((other, otherIndex) =>
            otherIndex > index && other.kind === "compaction"
        );
        if (nextCompaction !== -1) {
            const between = timeline.slice(index + 1, nextCompaction)
                .filter((other) => other.kind === "request");
            expect(between.length).toBeGreaterThan(3);
        }
    }

    for (const request of sent) {
        assertToolCallsPaired(
            request.messages as readonly ModelMessage[],
            "A sent request",
        );
    }
}

function bill(request: ModelRequest, charactersPerToken: number): number {
    let characters = (request.systemPrompt ?? "").length;
    for (const tool of request.tools ?? []) {
        characters += tool.name.length + tool.description.length
            + JSON.stringify(tool.inputSchema).length;
    }
    let reasoning = 0;
    for (const message of request.messages) {
        for (const block of message.content) {
            if (block.type === "text") characters += block.text.length;
            if (block.type === "tool_call") {
                characters += block.name.length + JSON.stringify(block.input).length;
            }
        }
        if (
            message.role === "assistant"
            && message.source.model === request.model
            && message.content.some((block) =>
                block.type === "thinking" && block.signature !== undefined
            )
        ) {
            reasoning += message.usage.reasoningTokens ?? 0;
        }
    }
    return Math.ceil(characters / charactersPerToken) + reasoning;
}

function lastRequestBefore(
    timeline: readonly Mark[],
    index: number,
): Extract<Mark, { kind: "request" }> | undefined {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const mark = timeline[cursor];
        if (mark?.kind === "request") return mark;
    }
    return undefined;
}

function firstRequestAfter(
    timeline: readonly Mark[],
    index: number,
): Extract<Mark, { kind: "request" }> | undefined {
    for (let cursor = index + 1; cursor < timeline.length; cursor += 1) {
        const mark = timeline[cursor];
        if (mark?.kind === "request") return mark;
    }
    return undefined;
}

function reasoningToolCall(round: number, reasoning: number): AssistantMessage {
    return {
        role: "assistant",
        content: [
            { type: "thinking", text: `tally ${round}`, signature: `sealed-${round}` },
            {
                type: "tool_call",
                id: `call-${round}`,
                name: "read",
                input: { path: `log-${round}.txt` },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "luna" },
        usage: {
            ...emptyUsage(),
            outputTokens: reasoning + 40,
            reasoningTokens: reasoning,
        },
        stopReason: "tool_use",
    };
}

function finalAnswer(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "luna" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function compactionOptions(): SessionCompactionOptions {
    const summarizer: ModelAdapter = {
        stream(request) {
            return new FauxAdapter([
                finalAnswer("# Task\nCount every doubloon.\n\n# State\nTallying."),
            ]).stream(request);
        },
    };
    return {
        strategy: fullSummaryStrategy,
        models: {
            [FULL_SUMMARY_MODEL_SLOT]: createRoutedCompletionService(
                summarizer,
                { models: [{ provider: "faux", model: "summarizer" }] },
            ),
        },
        diagnostics: {
            strategy: FULL_SUMMARY_STRATEGY_ID,
            provider: "faux",
            model: "summarizer",
        },
    };
}

async function drain(
    channel: ReturnType<typeof createInProcessChannel>,
): Promise<readonly AgentUpdate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const updates: AgentUpdate[] = [];
    try {
        for (;;) {
            const update = await channel.client.receive(controller.signal);
            updates.push(update);
            if (update.type === "turn_finished") return updates;
        }
    } catch {
        // Aborted by the timeout, which the assertions then report on.
    } finally {
        clearTimeout(timer);
    }
    return updates;
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-metered-e2e-"));
    temporaryDirectories.push(directory);
    return directory;
}
