import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    TuiAgentClient,
    TuiDependencies,
} from "../../../clients/tui/main.ts";
import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
    FULL_SUMMARY_STRATEGY_ID,
} from "../../../src/engine/compaction-full-summary.ts";
import { createRoutedCompletionService } from "../../../src/engine/completion-service.ts";
import { createInProcessChannel } from "../../../src/engine/message-channel.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";
import { runHeadlessLoop } from "../../../src/engine/run-turn.ts";
import { ModelEventStream } from "../../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../../src/model/types.ts";
import { SessionStore } from "../../../src/store/session-store.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

interface Gate {
    readonly opened: Promise<void>;
    open(): void;
}

function gate(): Gate {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

// Holds the first request behind the gate; later requests stream at once.
function heldFirst(inner: ModelAdapter, held: Gate): ModelAdapter {
    let calls = 0;
    return {
        stream(request) {
            calls += 1;
            if (calls > 1) return inner.stream(request);
            const out = new ModelEventStream();
            void held.opened.then(async () => {
                for await (const event of inner.stream(request)) out.push(event);
            });
            return out;
        },
    };
}

function answer(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function compactingDependencies(
    workspace: string,
    sent: ClientCommand[],
    firstTurn: Gate,
    summary: Gate,
): Promise<TuiDependencies> {
    const store = await SessionStore.create(
        join(workspace, "session.jsonl"),
        { sessionId: "queue-during-compaction", cwd: workspace },
    );
    const channel = createInProcessChannel();
    // About 5k tokens, so the next turn's pre-turn check crosses the trigger.
    const longLog = "the crow logs another league of open sea. ".repeat(500);
    const model = heldFirst(new FauxAdapter([
        answer(`CAPTAIN'S LOG ${longLog}`),
        answer("ABOUT TWO TIDES"),
        answer("HANDOFF WRITTEN"),
    ], { chunkSize: 4_000 }), firstTurn);
    const summarizer = heldFirst(new FauxAdapter([
        answer("# Task\nSail to the cove.\n\n# State\nThe log is long."),
    ]), summary);
    void runHeadlessLoop(channel.engine, model, "test", "high", {
        approvalMode: "auto",
    }, {
        sessionStore: store,
        compaction: {
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
            trigger: { tokens: 8_000 },
        },
        readModelSettings: () => ({
            model: "test",
            reasoningEffort: "high",
            contextWindow: 200_000,
        }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: {
            updateModelSettings: async () => undefined,
        },
    });

    const client: TuiAgentClient = {
        async send(command): Promise<void> {
            sent.push(command);
            channel.client.send(command);
        },
        receive(signal) {
            return channel.client.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };
    return { client };
}

function occurrences(pane: string, text: string): number {
    return pane.split(text).length - 1;
}

test("a prompt sent during pre-turn compaction is queued, not drawn as sent", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-queue-compaction-"));
    const workspace = mkdtempSync(join(tmpdir(), "vera-tui-queue-compaction-ws-"));
    const sent: ClientCommand[] = [];
    const firstTurn = gate();
    const summary = gate();
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => compactingDependencies(workspace, sent, firstTurn, summary),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("read me the whole log");
        session.sendKey("Enter");
        await session.waitForVisiblePane("esc to interrupt");

        session.sendText("how long will this take");
        session.sendKey("Enter");
        await session.waitForVisiblePane("queued · how long will this take");

        // The first turn ends, the queued prompt is claimed, and compaction runs before it starts.
        firstTurn.open();
        await session.waitForVisiblePane("compacting ");

        session.sendText("write this in a handoff");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("queued · write this in a handoff");
        expect(occurrences(pane, "write this in a handoff")).toBe(1);

        summary.open();
        const done = await session.waitForVisiblePaneWhere(
            (candidate) => candidate.includes("HANDOFF WRITTEN")
                && candidate.includes("Ctrl+P commands"),
            "both queued prompts answered",
        );
        expect(done.indexOf("how long will this take"))
            .toBeLessThan(done.indexOf("ABOUT TWO TIDES"));
        expect(done.indexOf("ABOUT TWO TIDES"))
            .toBeLessThan(done.indexOf("write this in a handoff"));
        expect(done.indexOf("write this in a handoff"))
            .toBeLessThan(done.indexOf("HANDOFF WRITTEN"));
        expect(occurrences(done, "write this in a handoff")).toBe(1);
        expect(done).not.toContain("queued ·");
        expect(sent.filter((command) => command.type === "prompt")).toHaveLength(3);
    } finally {
        summary.open();
        await session.close();
    }
}, 20_000);
