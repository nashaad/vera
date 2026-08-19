import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiNewSessionScenario,
} from "../../support/tui-new-session-child.ts";
import {
    createTuiCloneSessionScenario,
} from "../../support/tui-clone-session-child.ts";
import {
    createTuiForkSessionScenario,
} from "../../support/tui-fork-session-child.ts";
import { createTuiRenameDependencies } from "../../support/tui-rename-child.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("clear command leaves the current conversation for a fresh one", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-new-"));
    const scenario = createTuiNewSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        pane = await session.waitForVisiblePane("current-model");
        expect(pane).not.toContain("FULL ACCESS");
        session.sendText("/clear");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Could not start a new session: host refused creation",
        );
        expect(pane).toContain("ready");
        session.sendText("/clear");
        session.sendKey("Enter");
        await session.waitForVisiblePane("starting new session");
        pane = session.captureVisiblePane();
        expect(pane).toContain("Start a conversation");
        expect(pane).not.toContain("host refused creation");
        // The new session lands in the same TUI: the activity clears and
        // the failure notice goes with the transcript that held it, while
        // the process the pane belongs to is still the one that started.
        pane = await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("starting new session")
                && !visible.includes("host refused creation"),
            "the new session on screen",
        );
        expect(pane).toContain("Start a conversation");
        // The fresh session reports its own model and its own approval
        // mode: the status line never keeps describing the one that left.
        pane = await session.waitForVisiblePane("fresh-model");
        expect(pane).toContain("FULL ACCESS · RED ZONE");
        expect(pane).not.toContain("current-model");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "new-session-result.txt"), "utf8")).toBe(
            "new-session-id\ndetached\nnext detached\nattempts 2\n/work/vera",
        );
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);

test("rename commands name and clear without reaching the model", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-rename-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiRenameDependencies(home),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/rename Planning");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("session renamed: Planning");
        expect(pane).not.toContain("/rename Planning");
        expect(pane.split("\n").some((line) =>
            line.trim() === "SESSION  Planning"
        ))
            .toBe(true);

        session.sendText("/rename");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("session name cleared");
        expect(pane.split("\n").some((line) =>
            line.trim() === "SESSION  Planning"
        ))
            .toBe(false);
        session.sendKey("C-c");
        await session.waitForSessionExit();
        expect(readFileSync(join(home, "rename-result.txt"), "utf8"))
            .toBe("Planning\n<clear>");
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);

test("clone switches to the replacement without restarting the TUI", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-clone-"));
    const scenario = createTuiCloneSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/clone");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("cloning session");
        // A second /clone while the first is still in flight is dropped,
        // which the attempt count below is what proves.
        session.sendText("/clone");
        session.sendKey("Enter");
        await session.settle(50);
        expect(session.captureVisiblePane()).toContain("cloning session");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("cloning session"),
            "the clone on screen",
        );
        expect(pane).toContain("Start a conversation");
        // The clone reports its own model and approval mode rather than
        // inheriting the status line the source session left behind.
        pane = await session.waitForVisiblePane("cloned-model");
        expect(pane).toContain("FULL ACCESS · RED ZONE");
        expect(pane).not.toContain("source-model");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "clone-session-result.txt"), "utf8"))
            .toBe("cloned-session\ndetached\nattempts 1\nsource-session");
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);

test("fork prepares a replacement and restores the selected prompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-fork-"));
    const scenario = createTuiForkSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/fork");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Fork session");
        expect(pane).toContain("edit this prompt");
        session.sendKey("Enter");
        await session.waitForVisiblePane("forking session");
        // The fork lands in the same TUI: the prompt it was taken before
        // comes back to the composer without the screen being rebuilt.
        pane = await session.waitForVisiblePane("1 image attached");
        expect(pane).toContain("edit this prompt");
        expect(pane).not.toContain("forking session");
        // The fork reports its own model and approval mode.
        pane = await session.waitForVisiblePane("forked-model");
        expect(pane).toContain("FULL ACCESS · RED ZONE");
        expect(pane).not.toContain("source-model");
        // The first interrupt clears the restored draft and attachment;
        // the second exits the now-idle TUI.
        session.sendKey("C-c");
        await session.settle(50);
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(JSON.parse(readFileSync(
            join(home, "fork-session-result.txt"),
            "utf8",
        ))).toEqual({
            agentId: "forked-session",
            detached: true,
            forkBoundary: "prompt-1",
            forkedFrom: "source-session",
        });
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);

test("a stalled fork returns control to the source session", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-fork-timeout-"));
    const scenario = createTuiForkSessionScenario({
        home,
        forkTimeout: "timeout",
    });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/fork");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Fork session");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane(
            "Could not fork this session: timed out",
        );
        expect(pane).toContain("ready");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);

/**
 * Every session switch races the same deadline. A host that never answers used
 * to leave the TUI in a pending switch with no notice, no new prompt, and no
 * way to quit, so each of these drives the switch a different way and asserts
 * the same recovery: a notice, the old session still on screen, and ready.
 */
const stalledSwitches = [
    {
        name: "clear",
        scenario: (home: string) =>
            createTuiNewSessionScenario({ home, createTimeout: true }),
        command: "/clear",
        notice: "Could not start a new session: timed out",
        survivor: "current-model",
    },
    {
        name: "clone",
        scenario: (home: string) =>
            createTuiCloneSessionScenario({ home, cloneTimeout: true }),
        command: "/clone",
        notice: "Could not clone this session: timed out",
        survivor: "source-model",
    },
] as const;

for (const stalled of stalledSwitches) {
    test(`a stalled ${stalled.name} returns control to the current session`, async () => {
        const home = mkdtempSync(
            join(tmpdir(), `vera-tui-${stalled.name}-timeout-`),
        );
        const scenario = stalled.scenario(home);
        const session = await startTuiTestSession({
            home,
            width: 100,
            height: 30,
            dependencies: () => scenario.dependencies,
        });

        try {
            await session.waitForVisiblePane("Start a conversation");
            session.sendText(stalled.command);
            session.sendKey("Enter");
            const pane = await session.waitForVisiblePane(stalled.notice);
            expect(pane).toContain("ready");
            // The session that was on screen is still the attached one.
            expect(pane).toContain(stalled.survivor);
            session.sendKey("C-c");
            await session.waitForSessionExit();
        } finally {
            await session.close();
            rmSync(home, { recursive: true, force: true });
        }
    }, 15_000);
}

test("a stalled resume returns control to the current session", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-timeout-"));
    const scenario = createTuiResumeScenario({ home, resumeTimeout: true });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendKey("Down");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane(
            "Could not switch conversation: timed out",
        );
        expect(pane).toContain("ready");
        expect(pane).toContain("current-model");
        expect(pane).not.toContain("RESUMED HISTORY LOADED");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);

test("ctrl+c quits while a session switch is still pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-switch-quit-"));
    const scenario = createTuiForkSessionScenario({
        home,
        forkTimeout: "hold",
    });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/fork");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Fork session");
        session.sendKey("Enter");
        // The deadline is a minute out, so the switch is still pending and
        // ctrl+c is the only way out of it.
        await session.waitForVisiblePane("forking session");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 15_000);
