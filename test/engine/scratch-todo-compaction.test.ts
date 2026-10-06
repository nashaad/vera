import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
} from "../../src/engine/compaction-full-summary.ts";
import { createRoutedCompletionService } from "../../src/engine/completion-service.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    runHeadlessLoop,
    sessionScratchDir,
    type SessionCompactionOptions,
} from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const cleanup: string[] = [];

afterAll(() => {
    for (const directory of cleanup) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("scratch writes leave the system prompt alone, and compaction brings todo.md back", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-scratch-todo-"));
    cleanup.push(workspace);
    const sessionId = `scratch-todo-${crypto.randomUUID()}`;
    const scratchDir = sessionScratchDir(sessionId);
    cleanup.push(scratchDir);
    writeFileSync(join(scratchDir, "todo.md"), "- [ ] bury the chest\n");

    const store = await SessionStore.create(join(workspace, "session.jsonl"), {
        sessionId,
        cwd: workspace,
    });
    const sent: ModelRequest[] = [];
    const faux = new FauxAdapter([reply("one"), reply("two"), reply("three")]);
    const agent: ModelAdapter = {
        stream(request) {
            sent.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, agent, "test", undefined, {
        approvalMode: "auto",
    }, {
        sessionStore: store,
        compaction: compactionOptions(),
        readModelSettings: () => ({ model: "test", contextWindow: 200_000 }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: { updateModelSettings: async () => undefined },
    });

    channel.client.send({ type: "prompt", content: "first: " + "alpha ".repeat(800) });
    await drainUntil(channel, (update) => update.type === "turn_finished");

    writeFileSync(join(scratchDir, "map.txt"), "x marks the spot\n");
    writeFileSync(join(scratchDir, "todo.md"), "- [x] bury the chest\n- [ ] draw the map\n");
    channel.client.send({ type: "prompt", content: "second: " + "beta ".repeat(800) });
    await drainUntil(channel, (update) => update.type === "turn_finished");

    expect(sent).toHaveLength(2);
    expect(sent[1]!.systemPrompt).toBe(sent[0]!.systemPrompt);
    expect(JSON.stringify(sent)).not.toContain("bury the chest");

    channel.client.send({ type: "compact", requestId: "compact" });
    await drainUntil(channel, (update) =>
        update.type === "compaction" && update.phase === "finished"
    );
    channel.client.send({ type: "prompt", content: "third" });
    await drainUntil(channel, (update) => update.type === "turn_finished");

    const last = sent.at(-1)!;
    expect(last.systemPrompt).toBe(sent[0]!.systemPrompt);
    const texts = last.messages.map((message) =>
        message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")
    );
    const summaryAt = texts.findIndex((text) => text.startsWith("This is a summary"));
    const todoAt = texts.findIndex((text) => text.includes("- [ ] draw the map"));
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(todoAt).toBeGreaterThan(summaryAt);
    expect(texts[todoAt + 1]).toBe("third");
    expect(texts[todoAt]).toContain(join(scratchDir, "todo.md"));
}, 30_000);

function compactionOptions(): SessionCompactionOptions {
    const summarizer: ModelAdapter = {
        stream(request) {
            return new FauxAdapter([
                reply("# Task\nHide the treasure.\n\n# State\nTwo turns done."),
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

function reply(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function drainUntil(
    channel: ReturnType<typeof createInProcessChannel>,
    predicate: (update: AgentUpdate) => boolean,
): Promise<void> {
    const signal = AbortSignal.timeout(20_000);
    for (;;) {
        if (predicate(await channel.client.receive(signal))) return;
    }
}
