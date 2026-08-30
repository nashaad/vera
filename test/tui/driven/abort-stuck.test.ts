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
} from "../../../src/model/types.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const READY = "ready · ctrl+p";

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

test("empty Enter releases every queued prompt as its own turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-send-all-"));
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowTurnDependencies([
            "SLOW ANSWER",
            "ONE OK",
            "TWO OK",
        ], sent),
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

        session.sendKey("Enter");
        const answers = ["SLOW ANSWER", "ONE OK", "TWO OK"];
        const pane = await session.waitForVisiblePaneWhere(
            (candidate) => candidate.includes("ready · ctrl+p commands")
                && answers.filter((answer) => candidate.includes(answer)).length
                    >= 2,
            "two released turns and ready status",
        );
        expect(pane).toContain("first queued");
        expect(pane).toContain("second queued");
        expect(sent.filter((command) =>
            command.type === "release_queued_prompts"
            && command.mode === "all"
        )).toHaveLength(1);
    } finally {
        await session.close();
    }
}, 15_000);

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
        await session.waitForVisiblePane("ready · ctrl+p commands");
        session.sendText("typed behind fence");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("+1");

        expect(pane).toContain("queued · held first");
        expect(pane).toContain("ready · ctrl+p commands");
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
        await session.waitForVisiblePane("ready · ctrl+p commands");
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
): TuiDependencies {
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter(answers.map(response), {
            chunkSize: 1,
            delayMs: 250,
        }),
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
