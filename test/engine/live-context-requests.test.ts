import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
    FULL_SUMMARY_STRATEGY_ID,
} from "../../src/engine/compaction-full-summary.ts";
import { createRoutedCompletionService } from "../../src/engine/completion-service.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { runHeadlessLoop, type SessionCompactionOptions } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

interface Run {
    readonly sent: readonly ModelRequest[];
    readonly histories: readonly (readonly string[])[];
}

const run = runSession();

test("model requests match the recorded requests before and after a compaction and a rewind", async () => {
    const { sent } = await run;
    expect(sent.length).toBe(4);
    const workspace = temporaryDirectories[0]!;
    const normalized = JSON.stringify(sent.map((request) => request.messages), null, 1)
        .replaceAll(workspace, "<workspace>")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
        .replace(/scratch directory: [^\\]+/g, "scratch directory: <scratch>")
        .replace(/"(durationMs|startedAt|finishedAt)": [\d.]+/g, "\"$1\": 0");
    expect(normalized).toMatchSnapshot();
}, 30_000);

test("the history checkpoint after a compaction carries only the live context", async () => {
    const { histories } = await run;
    const afterCompaction = histories.findLast((texts) => texts.some((text) => text.includes("third")))!;
    expect(afterCompaction.some((text) => text.includes("first"))).toBe(false);
    expect(afterCompaction.some((text) => text.includes("third"))).toBe(true);
}, 30_000);

async function runSession(): Promise<Run> {
    const workspace = mkdtempSync(join(tmpdir(), "vera-live-context-"));
    temporaryDirectories.push(workspace);
    let ids = 0;
    const store = await SessionStore.create(join(workspace, "session.jsonl"), {
        sessionId: "live-context",
        cwd: workspace,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ids)),
        createId: () => `id-${(ids += 1)}`,
    });
    const sent: ModelRequest[] = [];
    const faux = new FauxAdapter([
        reply("one"),
        reply("two"),
        reply("three"),
        reply("four"),
    ]);
    const agent: ModelAdapter = {
        stream(request) {
            sent.push(JSON.parse(JSON.stringify(request)) as ModelRequest);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "test", undefined, { approvalMode: "auto" }, {
        sessionStore: store,
        compaction: compactionOptions(),
        readModelSettings: () => ({ model: "test", contextWindow: 200_000 }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: { updateModelSettings: async () => undefined },
    });
    const histories: string[][] = [];
    const until = async (predicate: (update: AgentUpdate) => boolean): Promise<AgentUpdate> => {
        for (;;) {
            const update = await channel.client.receive(AbortSignal.timeout(20_000));
            if (update.type === "history") histories.push(update.entries.map((entry) => JSON.stringify(entry)));
            if (predicate(update)) return update;
        }
    };
    const prompt = async (content: string): Promise<void> => {
        channel.client.send({ type: "prompt", content });
        await until((update) => update.type === "turn_finished");
    };

    await prompt("first question");
    await prompt(`second question ${"sea shanty ".repeat(4_000)}`);
    channel.client.send({ type: "compact", requestId: "compact-1" });
    await until((update) => update.type === "compaction" && update.phase === "finished");
    expect(store.latestCompaction()).toBeDefined();
    await prompt("third question");

    channel.client.send({ type: "list_timeline", requestId: "timeline-1" });
    const timeline = await until((update) => update.type === "timeline");
    const first = timeline.type === "timeline"
        ? timeline.boundaries.find((boundary) => boundary.prompt.startsWith("first"))
        : undefined;
    expect(first).toBeDefined();
    channel.client.send({
        type: "preview_timeline_action",
        requestId: "timeline-2",
        boundaryId: first!.userMessageId,
        action: "rewind_conversation",
    });
    const preview = await until((update) => update.type === "timeline_action_preview");
    const planId = preview.type === "timeline_action_preview" ? preview.plan.planId : "";
    channel.client.send({ type: "apply_timeline_action", requestId: "timeline-3", planId });
    await until((update) => update.type === "timeline_action_applied");
    await prompt("fourth question");
    return { sent, histories };
}

function reply(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function compactionOptions(): SessionCompactionOptions {
    const summarizer: ModelAdapter = {
        stream(request) {
            return new FauxAdapter([reply("# Task\nAnswer the crew.\n\n# State\nTwo questions answered.")]).stream(request);
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
        diagnostics: { strategy: FULL_SUMMARY_STRATEGY_ID, provider: "faux", model: "test" },
    };
}
