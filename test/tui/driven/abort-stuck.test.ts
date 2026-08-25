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

        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            pane = session.captureVisiblePane();
            expectNoSplitChrome(pane);
            if (pane.includes("FOLLOW UP")) break;
            await session.settle(40);
        }
        expect(pane).toContain("FOLLOW UP");
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

function slowTurnDependencies(
    answers: readonly string[],
    sent: ClientCommand[],
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

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
