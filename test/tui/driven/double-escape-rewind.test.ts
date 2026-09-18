import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type TuiAgentClient,
    type TuiDependencies,
} from "../../../clients/tui/main.ts";
import { createInProcessChannel } from "../../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../../src/model/types.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiRewindDependencies } from "../../support/tui-rewind-child.ts";

test("double escape opens the rewind picker when idle", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-esc-rewind-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiRewindDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("first request");
        session.sendKey("Enter");
        await session.waitForVisiblePane("FIRST ANSWER");
        // The transcript shows the answer before the turn is fully finished,
        // and rewind only opens once the agent is back to idle.
        await session.waitForVisiblePane("ready · Ctrl+P commands");

        // A single idle escape stays a no-op: no picker, no transcript change.
        // The settle between the two presses is above the native parser's
        // escape disambiguation delay (~23 ms), so each arrives as its own
        // literal escape, and still well inside the 500 ms pair window.
        session.sendKey("Escape");
        await session.settle(100);
        pane = session.captureVisiblePane();
        expect(pane).not.toContain("Rewind: select a point");
        expect(pane).toContain("FIRST ANSWER");

        // The second press inside the window opens the timeline picker,
        // exactly what /rewind opens.
        session.sendKey("Escape");
        pane = await session.waitForVisiblePane("Rewind: select a point");
        expect(pane).toContain("first request");
    } finally {
        await session.close();
    }
}, 15_000);

test("a key between the two escapes disarms the double press", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-esc-disarm-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiRewindDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("first request");
        session.sendKey("Enter");
        await session.waitForVisiblePane("FIRST ANSWER");
        await session.waitForVisiblePane("ready · Ctrl+P commands");

        // First escape arms. A typed key between the two presses disarms the
        // pair, and the composer ends empty again, so the next escape would
        // have opened rewind if the arm had survived. Each wait is above the
        // native parser's ~23 ms escape disambiguation delay, so every press
        // reaches the handler as its own literal event instead of merging
        // with the next raw byte.
        session.sendKey("Escape");
        await session.settle(50);
        session.sendText("x");
        await session.settle(50);
        session.sendKey("BSpace");
        await session.settle(50);
        session.sendKey("Escape");
        await session.settle(100);
        pane = session.captureVisiblePane();
        expect(pane).not.toContain("Rewind: select a point");

        // That last escape was a fresh first press, so let its arm expire
        // (settle longer than the 500 ms window) before the next phase.
        await session.settle(600);

        // The escape that clears a draft does not arm the pair either: if it
        // did, the final escape below would open rewind.
        session.sendKey("Escape");
        await session.settle(50);
        session.sendText("x");
        await session.settle(50);
        session.sendKey("Escape"); // clears the draft, does not open rewind
        await session.settle(50);
        pane = session.captureVisiblePane();
        expect(pane).not.toContain("Rewind: select a point");

        // One more press now has nothing to pair with either.
        session.sendKey("Escape");
        await session.settle(100);
        pane = session.captureVisiblePane();
        expect(pane).not.toContain("Rewind: select a point");
    } finally {
        await session.close();
    }
}, 15_000);

test("double escape while the agent is working still aborts, never rewinds", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-esc-working-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => slowRewindDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("long answer please");
        session.sendKey("Enter");
        // "esc stop" is the working hint, so this proves the slow turn is
        // visibly in flight before the escapes land.
        await session.waitForVisiblePane("esc stop");

        // The first literal plain escape aborts the turn and never arms the
        // pair. The second, spaced so it is its own literal press, either
        // lands while the abort is still pending (consumed) or after the turn
        // is back to idle (a fresh first press). Neither can open rewind.
        session.sendKey("Escape");
        await session.settle(50);
        session.sendKey("Escape");
        await session.settle(50);
        pane = session.captureVisiblePane();
        expect(pane).not.toContain("Rewind: select a point");

        // The aborted turn returns to idle without ever finishing the slow
        // answer, which is the proof the escape was a real abort and not a
        // swallowed keypress.
        pane = await session.waitForVisiblePane("ready · Ctrl+P commands");
        expect(pane).not.toContain("SLOW ANSWER");
    } finally {
        await session.close();
    }
}, 15_000);

/** The rewind scenario with a slow adapter, so a turn is provably in flight. */
function slowRewindDependencies(): TuiDependencies {
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([response("SLOW ANSWER")], {
            chunkSize: 5,
            delayMs: 200,
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
