import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient, TuiDependencies } from "../../../clients/tui/main.ts";
import type { HostStopWaitEvent } from "../../../src/host/protocol.ts";
import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

let cuts = 0;
let sent: string[] = [];
let emitStopWait: ((event: HostStopWaitEvent) => void) | undefined;

function createStopWaitDependencies(): TuiDependencies {
    const base = createTuiChildDependencies();
    const inner = base.client;
    const client: TuiAgentClient = {
        ...inner,
        async send(command) {
            sent.push(command.type);
            return inner.send(command);
        },
        onStopWait(listener) {
            emitStopWait = listener;
            return () => {
                emitStopWait = undefined;
            };
        },
    };
    // The stop-now action is cutStopWait in this tree and abortAgent in trees
    // that predate the cut; either one counts as the action.
    const dependencies = {
        ...base,
        client,
        cutStopWait: async () => {
            cuts += 1;
            return { type: "cut_stop_wait_done" as const, cut: ["s1"], failed: [] };
        },
        abortAgent: async () => {
            cuts += 1;
        },
    };
    return dependencies;
}

function openCard(): void {
    emitStopWait?.({
        type: "host_stop_wait",
        kind: "stop",
        waiting_on: [{ session_id: "s1", name: "Build", status: "working" }],
    });
}

async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await Bun.sleep(20);
    }
}

async function startWithQueuedPrompt(name: string) {
    cuts = 0;
    sent = [];
    const home = mkdtempSync(join(tmpdir(), name));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => createStopWaitDependencies(),
    });
    await session.waitForVisiblePane("Start a conversation");
    session.sendText("start streaming");
    session.sendKey("Enter");
    await session.waitForVisiblePane("PARTIAL xxxxx");
    session.sendText("first follow-up");
    session.sendKey("Enter");
    await session.waitForVisiblePane("queued · first follow-up");
    return session;
}

test("Down then Enter on the stop-wait card cuts once and releases nothing", async () => {
    const session = await startWithQueuedPrompt("vera-tui-card-down-");
    try {
        openCard();
        const pane = await session.waitForVisiblePane("Vera stops when running turns finish.");
        expect(pane).toContain("1. Keep waiting");
        expect(pane).toContain("2. Stop it now");
        expect(pane).not.toContain("recommended");
        expect(pane).not.toContain("Other");
        const before = sent.length;
        session.sendKey("Down");
        session.sendKey("Enter");
        await until(() => cuts === 1, "one cut");
        await session.settle(200);
        expect(cuts).toBe(1);
        expect(sent.slice(before)).not.toContain("release_queued_prompts");
        expect(sent.slice(before)).not.toContain("prompt");
    } finally {
        await session.close();
    }
}, 20_000);

test("Enter alone with a draft keeps waiting and leaves the draft in the composer", async () => {
    const session = await startWithQueuedPrompt("vera-tui-card-draft-");
    try {
        session.sendText("draft text");
        await session.waitForVisiblePane("draft text");
        openCard();
        await session.waitForVisiblePane("Vera stops when running turns finish.");
        const before = sent.length;
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Vera stops when running turns finish."),
            "card closed",
        );
        await session.settle(200);
        expect(cuts).toBe(0);
        expect(sent.slice(before)).not.toContain("prompt");
        expect(sent.slice(before)).not.toContain("release_queued_prompts");
        expect(session.captureVisiblePane()).toContain("draft text");
    } finally {
        await session.close();
    }
}, 20_000);

test("typing while the card is open cannot submit a freeform answer", async () => {
    const session = await startWithQueuedPrompt("vera-tui-card-typed-");
    try {
        session.sendText("draft text");
        await session.waitForVisiblePane("draft text");
        openCard();
        await session.waitForVisiblePane("Vera stops when running turns finish.");
        const before = sent.length;
        session.sendText("lets stop");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePaneWhere(
            (text) => !text.includes("Vera stops when running turns finish."),
            "card closed",
        );
        expect(pane).toContain("draft text");
        expect(pane).not.toContain("lets stop");
        expect(cuts).toBe(0);
        expect(sent.slice(before)).not.toContain("prompt");
        expect(sent.slice(before)).not.toContain("release_queued_prompts");
    } finally {
        await session.close();
    }
}, 20_000);

test("Stop it now with a draft cuts once and leaves the draft in the composer", async () => {
    const session = await startWithQueuedPrompt("vera-tui-card-stop-draft-");
    try {
        session.sendText("draft text");
        await session.waitForVisiblePane("draft text");
        openCard();
        await session.waitForVisiblePane("Vera stops when running turns finish.");
        const before = sent.length;
        session.sendKey("Down");
        session.sendKey("Enter");
        await until(() => cuts === 1, "one cut");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Vera stops when running turns finish."),
            "card closed",
        );
        await session.settle(200);
        expect(cuts).toBe(1);
        expect(sent.slice(before)).not.toContain("prompt");
        expect(sent.slice(before)).not.toContain("release_queued_prompts");
        expect(session.captureVisiblePane()).toContain("draft text");
    } finally {
        await session.close();
    }
}, 20_000);

test("Escape closes the stop-wait card and sends nothing", async () => {
    const session = await startWithQueuedPrompt("vera-tui-card-escape-");
    try {
        openCard();
        await session.waitForVisiblePane("Vera stops when running turns finish.");
        const before = sent.length;
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Vera stops when running turns finish."),
            "card closed",
        );
        await session.settle(200);
        expect(cuts).toBe(0);
        expect(sent.slice(before)).not.toContain("release_queued_prompts");
        expect(sent.slice(before)).not.toContain("prompt");
    } finally {
        await session.close();
    }
}, 20_000);
