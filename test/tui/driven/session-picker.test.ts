import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiResumeScenario, IDLE_TARGET_TRANSCRIPT } from "../../support/tui-resume-child.ts";
import {
    createTuiTrashSessionScenario,
} from "../../support/tui-trash-session-child.ts";
import {
    createTuiRenameSessionScenario,
} from "../../support/tui-rename-session-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("resume picker switches conversation without restarting the TUI", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Continue the theme picker");
        // The session already on screen is listed and says so, and Enter on
        // its row is a way out of the picker rather than a re-attach.
        expect(pane).toContain("The one already open");
        expect(pane).toContain("● just now");
        expect(pane).toContain("1h ago");
        expect(pane).not.toContain("empty-session-id");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("Continue the theme picker"),
            "the picker to close on the current session",
        );
        expect(pane).not.toContain("RESUMED HISTORY LOADED");
        expect(pane).not.toContain(IDLE_TARGET_TRANSCRIPT);

        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendKey("Down");
        session.sendKey("Enter");
        // Enter runs the row rather than previewing it: the file is resumed
        // and what lands is a conversation, not a transcript read from disk.
        pane = await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        // The picker is gone when its rows are. Picking a session is where the
        // person meant to go rather than a hop taken to answer something, so
        // nothing offers them a trip back from it.
        expect(pane).not.toContain("1h ago");
        expect(pane).not.toContain("/back");
        // The pane belongs to the process that started: the transcript was
        // replaced under a TUI that never went away.
        expect(pane).toContain("Message Vera");
        expect(pane).not.toContain(IDLE_TARGET_TRANSCRIPT);
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
            .toBe(
                `${scenario.targetPath}\ndetached\ntarget-session-id`
                    // Quitting closes the session in hand, and after the
                    // switch that is the resumed one as well as the one it
                    // replaced.
                    + "\nclosed current-session-id,target-session-id",
            );
    } finally {
        await session.close();
    }
}, 15_000);

test("session picker renames a conversation it is not attached to", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-"));
    const scenario = createTuiRenameSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Continue the theme picker");
        expect(pane).toContain("^r rename");
        session.sendKey("C-r");
        pane = await session.waitForVisiblePane("Rename conversation");
        // The field opens empty: the row text is a fallback, not a name.
        expect(pane).not.toContain("Rename conversation\nContinue");
        session.sendText("release notes");
        session.sendKey("Enter");
        // The pane comes back rebuilt from the host rather than patched.
        await session.waitForVisiblePane("release notes");
        session.sendKey("Escape");
        // The notice lands in the transcript, which the pane was covering.
        pane = await session.waitForVisiblePane(
            "session renamed: release notes",
        );
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(
            join(home, "rename-session-result.txt"),
            "utf8",
        )).toBe(
            "saved-session release notes\ncurrent Fix the deployment race",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("renaming the attached row goes through its own session", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-current-"));
    const scenario = createTuiRenameSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Fix the deployment race");
        session.sendKey("Down");
        session.sendKey("C-r");
        await session.waitForVisiblePane("Rename conversation");
        session.sendText("the current one");
        session.sendKey("Enter");
        await session.waitForVisiblePane("the current one");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePane(
            "session renamed: the current one",
        );
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        // The host was never asked: the attached session renames itself,
        // and the host refuses an attached target anyway.
        expect(readFileSync(
            join(home, "rename-session-result.txt"),
            "utf8",
        )).toBe("\ncurrent the current one");
    } finally {
        await session.close();
    }
}, 15_000);

test("a refused rename says so and leaves the pane open", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-busy-"));
    const scenario = createTuiRenameSessionScenario({
        home,
        renameBusy: true,
    });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendKey("C-r");
        await session.waitForVisiblePane("Rename conversation");
        session.sendText("release notes");
        session.sendKey("Enter");
        // The pane comes back with the row still under its old name.
        pane = await session.waitForVisiblePane("^r rename");
        expect(pane).toContain("Continue the theme picker");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePane("open in another client");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("session trash rejection keeps the picker usable", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-trash-busy-"));
    const scenario = createTuiTrashSessionScenario({ home, trashBusy: true });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendKey("DC");
        await session.waitForVisiblePane("Move conversation to Trash?");
        session.sendText("1");
        pane = await session.waitForVisiblePaneWhere(
            (current) => current.includes("Continue the theme picker")
                && !current.includes("Move conversation to Trash?"),
            "restored session picker after trash rejection",
        );
        expect(pane).toContain("Continue the theme picker");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePane("That con");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

