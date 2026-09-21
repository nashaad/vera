import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiInboxNoticeDependencies,
} from "../../support/tui-inbox-notice-child.ts";
import {
    createTuiInjectingDependencies,
} from "../../support/tui-injecting-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("agent inbox notice emphasizes and replaces the current unread count", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-inbox-notice-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiInboxNoticeDependencies(),
    });

    try {
        const pane = await session.waitForVisiblePane("Agent inbox");
        expect(pane).toContain("〰 Agent inbox 〰");
        expect(pane).toContain("2 unread inbox entries");
        expect(pane).not.toContain("1 unread inbox entry");
    } finally {
        await session.close();
    }
}, 15_000);

test("an injected head stays hidden through the turns that follow", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-seat-stay-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiInjectingDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");

        session.sendText("first");
        session.sendKey("Enter");
        // Mid-turn frames can carry the head for an instant before the band
        // rebuilds the transcript; the settled state is what stays hidden.
        pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("AGENT SAW THE HEAD")
                && !visible.includes("system-note"),
            "the finished turn without the injected head",
        );
        expect(pane).not.toContain("system-note");

        // Every later turn rebuilds the transcript from the canonical
        // messages, which carry the head the band must keep hiding.
        for (const text of ["second", "third"]) {
            session.sendText(text);
            session.sendKey("Enter");
            await session.waitForVisiblePane(text);
            await session.settle(400);
            pane = session.captureVisiblePane();
            expect(pane).not.toContain("system-note");
        }
    } finally {
        await session.close();
    }
}, 30_000);

test("an unknown slash command stays in the composer and never reaches the model", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-unknown-command-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiInjectingDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/modle");
        session.sendKey("Enter");
        await session.waitForVisiblePane(
            "Unknown command: /modle. Did you mean /model?",
        );
        await session.settle(300);
        expect(await session.captureVisiblePane()).not.toContain("AGENT SAW");

        // The draft was kept, so erasing it takes one Backspace per character.
        for (let index = 0; index < "/modle".length; index += 1) {
            session.sendKey("BSpace");
        }
        session.sendText("/tmp/a.txt hi");
        session.sendKey("Enter");
        await session.waitForVisiblePane("AGENT SAW NO HEAD");
    } finally {
        await session.close();
    }
}, 15_000);
