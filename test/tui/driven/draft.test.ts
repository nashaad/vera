import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("ctrl+c clears an idle draft before it quits", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("keep me from quitting");
        await session.waitForVisiblePane("keep me from quitting");

        session.sendKey("C-c");
        const pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("keep me from quitting"),
            "ctrl+c to clear the draft without quitting",
        );
        expect(pane).toContain("ready");

        session.sendKey("C-c");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("ctrl+c on an empty composer asks for a second press before it quits", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");

        // Typing shows the first press did not quit; clearing the draft starts over.
        session.sendText("still here");
        await session.waitForVisiblePane("still here");
        session.sendKey("C-c");
        const pane = await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("still here") && !visible.includes("again to quit"),
            "the draft cleared and the quit disarmed",
        );
        expect(pane).toContain("ready");

        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("the armed quit has no time limit", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");
        await session.settle(6_000);
        expect(await session.waitForVisiblePane("Press Ctrl+C again to quit")).toContain("Press Ctrl+C again to quit");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 20_000);

test("escape cancels the armed quit", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");
        session.sendKey("Escape");
        const pane = await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("again to quit") && visible.includes("ready"),
            "escape to disarm the quit",
        );
        expect(pane).toContain("Message Vera");

        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("the armed quit hint hides while a draft would take the next ctrl+c", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-draft-interrupt-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-c");
        await session.waitForVisiblePane("Press Ctrl+C again to quit");

        session.sendText("ahoy");
        await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("ahoy") && !visible.includes("again to quit"),
            "the draft to hide the quit hint",
        );
        for (let i = 0; i < 4; i += 1) session.sendKey("BSpace");
        await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("ahoy") && visible.includes("Press Ctrl+C again to quit"),
            "the quit hint to return with the draft gone",
        );
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);
