import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("help is browse-only and ctrl+p opens the functional palette", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-help-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiChildDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        await session.waitForVisiblePane("test · HIGH");
        session.sendText("/help");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Vera keeps agent sessions resident",
        );
        expect(pane).toContain("General");
        session.sendKey("Right");
        pane = await session.waitForVisiblePane("Open the command palette");
        session.sendKey("Right");
        pane = await session.waitForVisiblePane(
            "Learn Vera controls and command",
        );
        session.sendKey("Enter");
        pane = session.captureVisiblePane();
        expect(pane).toContain("Help");
        expect(pane).toContain("/palette");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("←→ tabs"),
            "Help to close",
        );
        // ctrl+p is the advertised way in; the /palette alias is a fallback.
        session.sendText("/");
        await session.waitForVisiblePane("Rewind the active conversation");
        session.sendKey("C-p");
        pane = await session.waitForVisiblePane("Commands");
        // The composer stays behind the overlay, and its frame carries the
        // row that says what the session is answering as.
        expect(pane).toContain("test · HIGH");
        expect(pane).toContain("settings    Switch model");
        expect(pane).not.toContain("Rewind the active conversation");
        session.sendText("switch model");
        pane = await session.waitForVisiblePane("switch model");
        expect(pane).toContain("Switch model");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Select model");
        // The composer stays behind the overlay, and its frame carries the
        // row that says what the session is answering as.
        expect(pane).toContain("test · HIGH");
        expect(pane).not.toContain("switch model");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("Select model"),
            "model picker to close",
        );
        session.sendText("/palette");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Commands");
        // "recolor" is in no command name, so only description search finds
        // it: the reason the palette earns a place beside the composer.
        session.sendText("recolor");
        // Waiting for "recolor" alone matches the unfiltered list, whose
        // description column already carries the word. The filtered list is
        // the one without the rows the query dropped.
        pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("recolor")
                && !visible.includes("Rename conversation"),
            "the filtered palette",
        );
        expect(pane).toContain("Change theme");
        expect(pane).toContain("/themes");
        expect(pane).not.toContain("Rename conversation");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Theme");
        expect(pane).toContain("System");
        expect(pane).not.toContain("/help");
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);

test("a keybinding Vera cannot use is named at startup", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-keymap-notice-"));
    const profileDirectory = join(home, ".vera", "profiles", "default");
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
        join(profileDirectory, "tui.json"),
        JSON.stringify({
            keybindings: {
                "dials.open": ["ctrl+alt+q"],
                no_such_binding: ["ctrl+j"],
            },
        }),
    );
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        // The first history rebuilds the transcript, so a notice settled
        // before it is the one that used to be painted and then dropped.
        const pane = await session.waitForVisiblePane(
            "no_such_binding: unknown binding id",
        );
        expect(pane).toContain("dials.open");
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);
