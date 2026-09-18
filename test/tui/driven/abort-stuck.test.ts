import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type TuiAgentClient,
    type TuiDependencies,
} from "../../../clients/tui/main.ts";
import { createInProcessChannel } from "../../../src/engine/message-channel.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";
import { runHeadlessLoop } from "../../../src/engine/run-turn.ts";
import {
    HOST_CAPABILITY_PROMPT_QUEUE_RELEASE,
} from "../../../src/host/capabilities.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../../src/model/types.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const READY = "ready · Ctrl+P";

function chromeIsBusy(pane: string): boolean {
    return pane.includes("stopping…")
        || pane.includes("thinking")
        || pane.includes("esc stop");
}

function expectNoSplitChrome(pane: string): void {
    if (chromeIsBusy(pane) && pane.includes(READY)) {
        throw new Error(
            "ready painted beside a live turn\n\nPane:\n" + pane,
        );
    }
}

test("Escape then a queued prompt during stop runs the follow-up", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-abort-queue-"));
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowTurnDependencies([
            "SLOW ANSWER",
            "FOLLOW UP",
        ], sent),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("long answer please");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("esc stop");
        expectNoSplitChrome(pane);

        session.sendKey("Escape");
        await session.settle(40);
        pane = session.captureVisiblePane();
        expectNoSplitChrome(pane);

        session.sendText("now this instead");
        session.sendKey("Enter");

        await session.waitForVisiblePane("now this instead");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            pane = session.captureVisiblePane();
            expectNoSplitChrome(pane);
            if (
                pane.includes("SLOW ANSWER")
                || pane.includes("FOLLOW UP")
            ) break;
            await session.settle(40);
        }
        expect(
            pane.includes("SLOW ANSWER") || pane.includes("FOLLOW UP"),
        ).toBe(true);
        expect(pane).not.toContain("stopping…");
        expect(sent.some((command) => command.type === "abort")).toBe(true);
        expect(sent.some((command) =>
            command.type === "prompt"
            && command.content === "now this instead"
        )).toBe(true);
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+C while a stop is in flight quits the TUI", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-abort-quit-"));
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowTurnDependencies(["SLOW ANSWER"], sent),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("long answer please");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("esc stop");
        expectNoSplitChrome(pane);

        session.sendKey("Escape");
        await session.settle(20);
        expectNoSplitChrome(session.captureVisiblePane());
        expect(sent.some((command) => command.type === "abort")).toBe(true);
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("empty Enter releases every queued prompt in one model turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-send-all-"));
    const sent: ClientCommand[] = [];
    const requests: ModelRequest[] = [];
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowTurnDependencies([
            "SLOW ANSWER",
            "BATCH OK",
        ], sent, false, requests),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("long answer please");
        session.sendKey("Enter");
        await session.waitForVisiblePane("esc stop");

        session.sendText("first queued");
        session.sendKey("Enter");
        await session.waitForVisiblePane("queued · first queued");
        session.sendText("second queued");
        session.sendKey("Enter");
        await session.waitForVisiblePane("+1");

        const heldPane = await session.waitForVisiblePaneWhere(
            (candidate) => candidate.includes("ready · Ctrl+P commands")
                && candidate.includes("queued · first queued")
                && candidate.includes("+1"),
            "held queue after the active turn finishes",
        );
        expect(heldPane).not.toContain("BATCH OK");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePaneWhere(
            (candidate) => candidate.includes("ready · Ctrl+P commands")
                && candidate.includes("BATCH OK"),
            "one batched answer and ready status",
        );
        expect(pane).toContain("first queued");
        expect(pane).toContain("second queued");
        const userTexts = requests.at(-1)?.messages.flatMap((message) =>
            message.role !== "user"
                ? []
                : message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
        );
        expect(userTexts?.slice(-2)).toEqual([
            "first queued",
            "second queued",
        ]);
        expect(sent.filter((command) =>
            command.type === "release_queued_prompts"
            && command.mode === "all"
        )).toHaveLength(1);
    } finally {
        await session.close();
    }
}, 15_000);

test("empty Enter steers a released prompt that is still running", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-steer-batch-"));
    const sent: ClientCommand[] = [];
    const requests: ModelRequest[] = [];
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowTurnDependencies([
            "SLOW ANSWER",
            "FIRST OUT",
            "BATCH OK",
        ], sent, false, requests),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("long answer please");
        session.sendKey("Enter");
        await session.waitForVisiblePane("esc stop");

        session.sendText("first queued");
        session.sendKey("Enter");
        await session.waitForVisiblePane("queued · first queued");
        session.sendText("second queued");
        session.sendKey("Enter");
        await session.waitForVisiblePane("+1");
        session.sendText("third queued");
        session.sendKey("Enter");
        await session.waitForVisiblePane("+2");

        session.sendKey("Escape");
        // The fence released the oldest prompt; the rest stay held and must
        // still read as held while the queue drains.
        const draining = await session.waitForVisiblePaneWhere(
            (candidate) => candidate.includes("queued · second queued")
                && candidate.includes("+1"),
            "held prompts during a draining queue",
        );
        expect(draining).not.toContain("sending · second queued");

        session.sendKey("Enter");
        const pane = await session.waitForVisiblePaneWhere(
            (candidate) => candidate.includes("ready · Ctrl+P commands")
                && candidate.includes("second queued")
                && candidate.includes("third queued"),
            "the steered batch ran both held prompts",
        );
        // The released prompt's turn was stopped, not left to finish.
        expect(pane).toContain("Interrupted");

        const userTexts = requests.at(-1)?.messages.flatMap((message) =>
            message.role !== "user"
                ? []
                : message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
        );
        expect(userTexts?.slice(-2)).toEqual([
            "second queued",
            "third queued",
        ]);
    } finally {
        await session.close();
    }
}, 20_000);

test("a typed prompt stays queued behind an idle send-one fence", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-idle-fence-"));
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowTurnDependencies([
            "ACTIVE",
            "RELEASED",
            "HELD",
            "TYPED",
        ], sent),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("long answer please");
        session.sendKey("Enter");
        await session.waitForVisiblePane("esc stop");

        session.sendText("released first");
        session.sendKey("Enter");
        await session.waitForVisiblePane("queued · released first");
        session.sendText("held first");
        session.sendKey("Enter");
        await session.waitForVisiblePane("+1");
        session.sendKey("Escape");

        await session.waitForVisiblePane("queued · held first");
        await session.waitForVisiblePane("ready · Ctrl+P commands");
        session.sendText("typed behind fence");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("+1");

        expect(pane).toContain("queued · held first");
        expect(pane).toContain("ready · Ctrl+P commands");
        expect(pane).not.toContain("stopping…");
        expect(sent.some((command) =>
            command.type === "prompt"
            && command.content === "typed behind fence"
        )).toBe(true);
    } finally {
        await session.close();
    }
}, 15_000);

test("a legacy host still advances its client-owned prompt queue", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-legacy-queue-"));
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowTurnDependencies([
            "FIRST OK",
            "SECOND OK",
        ], sent, true),
    });

    try {
        await session.waitForVisiblePane("ready · Ctrl+P commands");
        session.sendText("first");
        session.sendKey("Enter");
        await session.waitForVisiblePane("esc stop");
        session.sendText("second");
        session.sendKey("Enter");
        await session.waitForVisiblePane("queued · second");

        const pane = await session.waitForVisiblePane("SECOND OK");
        expect(pane).not.toContain("queued · second");
    } finally {
        await session.close();
    }
}, 15_000);

function slowTurnDependencies(
    answers: readonly string[],
    sent: ClientCommand[],
    legacyQueue = false,
    requests?: ModelRequest[],
): TuiDependencies {
    const channel = createInProcessChannel();
    const faux = new FauxAdapter(answers.map(response), {
        chunkSize: 1,
        delayMs: 250,
    });
    const adapter: ModelAdapter = requests === undefined
        ? faux
        : {
            stream(request) {
                requests.push(request);
                return faux.stream(request);
            },
        };
    void runHeadlessLoop(
        channel.engine,
        adapter,
        "test",
        "high",
        {
            approvalMode: "auto",
        },
        {
            readModelSettings: () => ({
                model: "test",
                reasoningEffort: "high",
            }),
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
            router: {
                updateModelSettings: async () => undefined,
            },
        },
    );

    const client: TuiAgentClient = {
        ...(legacyQueue
            ? {
                supportsHostCapability(capability: string): boolean {
                    return capability !== HOST_CAPABILITY_PROMPT_QUEUE_RELEASE;
                },
            }
            : {}),
        async send(command): Promise<void> {
            sent.push(command);
            channel.client.send(command);
        },
        async receive(signal) {
            while (true) {
                const update = await channel.client.receive(signal);
                if (legacyQueue && update.type === "prompt_queue") continue;
                if (legacyQueue && update.type === "turn_finished") {
                    // A real pre-capability host auto-starts the prompt the
                    // legacy client already submitted. The current engine
                    // holds it, so the fixture reproduces that old boundary.
                    channel.client.send({
                        type: "release_queued_prompts",
                        mode: "one",
                    });
                }
                if (
                    legacyQueue
                    && update.type === "history"
                    && update.promptQueue !== undefined
                ) {
                    const { promptQueue: _promptQueue, ...history } = update;
                    return history;
                }
                return update;
            }
        },
        async detach(): Promise<void> {},
        close(): void {},
    };

    return { client };
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
