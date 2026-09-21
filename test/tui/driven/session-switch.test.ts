import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
import { createTuiResumeScenario, IDLE_TARGET_TRANSCRIPT } from "../../support/tui-resume-child.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import themeCatalog from "../../../config/tui-themes.json" with { type: "json" };
import { VERA_TUI_THEME } from "../../../clients/tui/theme.ts";
import {
    saveTuiPersistedAgentPane,
} from "../../../clients/tui/theme-preference.ts";

async function chooseCreateLeave(
    session: Awaited<ReturnType<typeof startTuiTestSession>>,
    disposition: "stop" | "keep_running" = "stop",
): Promise<void> {
    await session.waitForVisiblePane("Close this conversation");
    // Composer Enter can also land on this menu. ignoreEnter swallows that
    // leftover on the same tick, then a 0-timer disarms it. Waiting for the
    // menu can return in that same tick, so yield before confirming.
    await session.settle(50);
    if (disposition === "keep_running") {
        session.sendKey("Down");
        session.sendKey("Enter");
        return;
    }
    session.sendKey("Enter");
}

test("idle TUI exit stops the current conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-exit-close-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
            .toBe(
                "none\ndetached\ncurrent-session-id"
                    + "\nclosed current-session-id",
            );
    } finally {
        await session.close();
    }
}, 15_000);

test("idle TUI exit only detaches when another viewer remains", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-exit-shared-"));
    const scenario = createTuiResumeScenario({
        home,
        otherInteractiveAttachments: 1,
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8")).toBe(
            "none\ndetached\ncurrent-session-id\nclosed ",
        );
    } finally {
        await session.close();
    }
}, 15_000);

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
        await chooseCreateLeave(session);
        pane = await session.waitForVisiblePane(
            "Could not start a new session: host refused creation",
        );
        expect(pane).toContain("ready");
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
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
            "new-session-id\ndetached\nnext detached\nattempts 2\n/work/vera"
                + "\nclosed current-session-id,new-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("keep running leaves the source idle", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-new-background-"));
    const scenario = createTuiNewSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        // The fixture refuses its first create so this also proves a failed
        // destination never applies the leave disposition early.
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
        await session.waitForVisiblePane(
            "Could not start a new session: host refused creation",
        );
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session, "keep_running");
        await session.waitForVisiblePane("fresh-model");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "new-session-result.txt"), "utf8")).toBe(
            "new-session-id\ndetached\nnext detached\nattempts 2\n/work/vera"
                + "\nclosed new-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("clear keeps a multiply-attached source running and says why", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-clear-shared-"));
    const scenario = createTuiNewSessionScenario({
        home,
        otherInteractiveAttachments: 1,
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
        await session.waitForVisiblePane(
            "Could not start a new session: host refused creation",
        );
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
        const pane = await session.waitForVisiblePane(
            "The previous conversation is still running in another client",
        );
        expect(pane).toContain("fresh-model");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "new-session-result.txt"), "utf8")).toBe(
            "new-session-id\ndetached\nnext detached\nattempts 2\n/work/vera"
                + "\nclosed new-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("resume leaves a multiply-attached source running and says why", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-shared-"));
    const scenario = createTuiResumeScenario({
        home,
        otherInteractiveAttachments: 1,
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/resume");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendKey("Down");
        session.sendKey("Enter");
        // Stop & switch, the first row of the leave menu.
        session.sendKey("Enter");
        await session.waitForVisiblePane(
            "The previous conversation is still running in another client",
        );
        const pane = await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        expect(pane).toContain(
            "The previous conversation is still running in another client",
        );
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8")).toBe(
            `${scenario.targetPath}\ndetached\ntarget-session-id`
                + "\nclosed target-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("clear keeps the source and cleans up its target when close fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-new-close-failure-"));
    const scenario = createTuiNewSessionScenario({ home, closeFailure: true });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
        await session.waitForVisiblePane(
            "Could not start a new session: host refused creation",
        );
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
        const pane = await session.waitForVisiblePane(
            "Could not start a new session: the host could not stop the current conversation",
        );
        expect(pane).toContain("current-model");
        expect(pane).not.toContain("fresh-model");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "new-session-result.txt"), "utf8")).toBe(
            "current-session-id\ndetached\nnext detached\nattempts 2\n/work/vera"
                + "\nclosed new-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("a delayed extension insertion goes stale across clear", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-compose-clear-"));
    const scenario = createTuiNewSessionScenario({ home });
    const delayedResultPath = join(home, "delayed-compose-result.txt");
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            disabledIncludedExtensions: [
                "vera.model-presets",
                "vera.reasoning-cycle",
            ],
            clientExtensions: [{
                path: join(
                    import.meta.dir,
                    "../../support/fixtures/compose-write-extension",
                ),
                enabled: true,
                config: { delayedResultPath },
            }],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/compose-w");
        await session.waitForVisiblePane("Insert text into the composer");
        for (let index = 0; index < "/compose-w".length; index += 1) {
            session.sendKey("BSpace");
        }

        // The scenario's first creation is deliberately refused. This gets
        // the next /clear onto the successful replacement path.
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
        await session.waitForVisiblePane(
            "Could not start a new session: host refused creation",
        );

        session.sendKey("C-l");
        session.sendText("/clear");
        session.sendKey("Enter");
        await chooseCreateLeave(session);
        await session.waitForVisiblePane("fresh-model");
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (existsSync(delayedResultPath)) break;
            await Bun.sleep(20);
        }
        expect(readFileSync(delayedResultPath, "utf8")).toBe("stale");
        const pane = session.captureVisiblePane();
        expect(pane).not.toContain("stale text must not land");

        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
    } finally {
        await session.close();
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

        session.sendText("/rename");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("session name cleared");
        session.sendKey("C-c");
        await session.waitForSessionExit();
        expect(readFileSync(join(home, "rename-result.txt"), "utf8"))
            .toBe("Planning\n<clear>");
    } finally {
        await session.close();
    }
}, 15_000);

test("clone switches to the replacement without restarting the TUI", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-clone-"));
    const release = Promise.withResolvers<void>();
    const scenario = createTuiCloneSessionScenario({
        home,
        release: release.promise,
    });
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
        release.resolve();
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
            if (stalled.command === "/clear") {
                await chooseCreateLeave(session);
            }
            const pane = await session.waitForVisiblePane(stalled.notice);
            expect(pane).toContain("ready");
            // The session that was on screen is still the attached one.
            expect(pane).toContain(stalled.survivor);
            session.sendKey("C-c");
            await session.waitForSessionExit();
        } finally {
            await session.close();
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
        session.sendText("theme");
        await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("Continue the theme picker")
                && !visible.includes("The one already open"),
            "the picker filtered to the timed-out conversation",
        );
        session.sendKey("Enter");
        // Stop & switch, the first row of the leave menu.
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
    }
}, 15_000);

test("Ctrl+C quits while a session switch is still pending", async () => {
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
        // Ctrl+C is the only way out of it.
        await session.waitForVisiblePane("forking session");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("resuming a session from the list offers no way back", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-back-name-"));
    const scenario = createTuiResumeScenario({ home });
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
        // Stop & switch, the first row of the leave menu.
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        // /resume is navigation, not a hop: the person chose the destination,
        // so there is no trip back to name.
        expect(pane).not.toContain("/back");
        expect(pane).not.toContain("This conversation is idle.");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("resume asks, and switch keep running leaves the source running", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-background-"));
    const scenario = createTuiResumeScenario({ home });
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
        const pane = await session.waitForVisiblePane("Continue the theme picker");
        expect(pane).toContain("⏎ switch");
        expect(pane).not.toContain("keep running");
        session.sendKey("Down");
        session.sendKey("Tab");
        session.sendKey("Enter");
        const menu = await session.waitForVisiblePane("Switch, keep running");
        expect(menu).toContain("Stop & switch");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
            .toBe(
                `${scenario.targetPath}\ndetached\ntarget-session-id`
                    + "\nclosed target-session-id",
            );
    } finally {
        await session.close();
    }
}, 15_000);

test("resume stays on the source when its tree cannot be stopped", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-close-failure-"));
    const scenario = createTuiResumeScenario({ home, closeFailure: true });
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
        // Stop & switch, the first row of the leave menu.
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane(
            "Could not switch conversation: the host could not stop the current conversation",
        );
        expect(pane).toContain("current-model");
        expect(pane).not.toContain("RESUMED HISTORY LOADED");
        expect(pane).not.toContain(IDLE_TARGET_TRANSCRIPT);
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
            .toBe(
                `${scenario.targetPath}\ndetached\ncurrent-session-id`
                    + "\nclosed ",
            );
    } finally {
        await session.close();
    }
}, 15_000);

test("resume does not show the destination before source quiescence", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-resume-quiescence-"));
    const scenario = createTuiResumeScenario({ home, closeDelayMs: 300 });
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
        // Stop & switch, the first row of the leave menu.
        session.sendKey("Enter");
        const pending = await session.waitForVisiblePane("switching conversation");
        expect(pending).toContain("current-model");
        expect(pending).not.toContain(IDLE_TARGET_TRANSCRIPT);
        expect(pending).not.toContain("RESUMED HISTORY LOADED");
        await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("back typed in the composer runs the command instead of prompting", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-back-"));
    const scenario = createTuiNewSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/back");
        session.sendKey("Enter");
        // With no hop recorded the command answers in place; the text
        // reaching the model instead would leave this notice unsaid.
        await session.waitForVisiblePane("Nothing to go back to");
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+E opens the same conversation picker as /resume", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-sidebar-keep-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-e");
        const pane = await session.waitForVisiblePane("Continue the theme picker");
        expect(pane).toContain("Resume");
        expect(pane).toContain("The one already open");
        expect(pane).toContain("RECENT");
        expect(pane).toContain("Ctrl+R rename");
        session.sendKey("C-e");
        await session.waitForVisiblePaneWhere(
            (visible) => !visible.includes("Continue the theme picker"),
            "the conversation picker to close",
        );
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
            .toBe("none\ndetached\ncurrent-session-id\nclosed current-session-id");
    } finally {
        await session.close();
    }
}, 15_000);

test("an idle file shows resume instead of the composer, and enter starts the worker", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-idle-resume-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/close");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("This conversation is idle.");
        expect(pane).toContain("hello from disk");
        expect(pane).toContain("Ctrl+N new");
        expect(pane).not.toContain("RESUMED HISTORY LOADED");
        expect(pane).not.toContain("permissions loading");
        // The slot is the composer's frame, not a frame of its own: top rule
        // bottom, seven rows, so nothing about the shape changes when the
        // conversation wakes into a real composer.
        const frameTop = pane.split("\n").findIndex((line) =>
            line.includes("\u256d")
        );
        const frame = pane.split("\n").slice(frameTop, frameTop + 7);
        expect(frame.at(-1)).toContain("\u2570");
        expect(frame[1]).toContain("Start typing or enter to continue");
        expect(frame[4]).toMatch(/\u2502 \u2500+ \u2502/);
        // The block above is a tinted band that runs to both edges, and it is
        // not the ground a user message uses: this is the room talking.
        const tinted = session.captureSpans().lines
            .filter((line) =>
                line.spans.some((span) =>
                    span.text.includes("This conversation is idle.")
                )
            );
        expect(tinted).toHaveLength(1);
        const band = tinted[0]?.spans.at(-1);
        expect(band?.text.trimEnd()).toBe("");
        const chatGround = session.captureSpans().lines
            .find((line) =>
                line.spans.some((span) => span.text.includes("\u256d"))
            )?.spans.at(-1);
        expect(band?.bg?.toInts().toString()).not.toBe(
            chatGround?.bg?.toInts().toString(),
        );
        session.sendKey("C-p");
        pane = await session.waitForVisiblePane("Resume this conversation");
        expect(pane).not.toContain("Stop this conversation");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("This conversation is idle.")
                && !visible.includes("Resume this conversation"),
            "the closed file after the palette closes",
        );
        expect(pane).toContain("hello from disk");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        expect(pane).toContain("resumed-model");
        expect(pane).not.toContain("This conversation is idle.");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
            .toBe(
                `${join(home, "sessions", "current.jsonl")}\ndetached\ntarget-session-id`
                    + "\nclosed current-session-id,target-session-id",
            );
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+E opens the conversation picker from an idle file", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-idle-picker-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/close");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Ctrl+N new");
        session.sendKey("C-e");
        const pane = await session.waitForVisiblePane("Continue the theme picker");
        expect(pane).toContain("Resume");
        expect(pane).toContain("The one already open");
        session.sendKey("Escape");
        await session.waitForVisiblePane("Ctrl+N new");
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+N from an idle file starts a new chat", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-idle-new-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => ({
            ...scenario.dependencies,
            createSession: async (workspace) => createSettingsAnsweringClient({
                agentId: "new-session-id",
                workspace,
                model: "fresh-model",
                mode: "full_access",
                initialUpdates: [{
                    type: "history",
                    entries: [],
                    seq: 0,
                }],
            }),
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/close");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation is idle.");
        session.sendKey("C-n");
        const pane = await session.waitForVisiblePane("fresh-model");
        expect(pane).not.toContain("This conversation is idle.");
    } finally {
        await session.close();
    }
}, 15_000);

test("escape from an idle file goes home", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-idle-home-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/close");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("This conversation is idle.");
        expect(pane).toContain("esc home");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePane("V  E  R  A");
        // Backing out of a file is a screen change, not a session change: the
        // file is still on disk and nothing was started to get here.
        expect(pane).not.toContain("This conversation is idle.");
        expect(pane).not.toContain("Message Vera");
    } finally {
        await session.close();
    }
}, 15_000);

test("picking a live conversation from Ctrl+E asks, then attaches", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-sidebar-attach-"));
    const scenario = createTuiResumeScenario({ home, targetLive: true });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-e");
        await session.waitForVisiblePane("Continue the theme picker");
        session.sendText("theme");
        await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("Continue the theme picker")
                && !visible.includes("The one already open"),
            "the picker filtered to the live conversation",
        );
        session.sendKey("Enter");
        await session.waitForVisiblePane("Stop & switch");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("RESUMED HISTORY LOADED");
        expect(pane).not.toContain(IDLE_TARGET_TRANSCRIPT);
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8"))
            .toBe(
                `${scenario.targetPath}\ndetached\ntarget-session-id`
                    + "\nclosed current-session-id,target-session-id",
            );
    } finally {
        await session.close();
    }
}, 15_000);

test("theme preview and cancel repaint an attached sidebar transcript", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-sidebar-theme-"));
    const scenario = createTuiResumeScenario({ home });
    saveTuiPersistedAgentPane(
        "current-session-id",
        {
            mainAgentId: "current-session-id",
            sidebarAgentId: "theme-sidebar-id",
            owner: "vera.btw",
        },
        join(home, ".vera", "tui.json"),
    );
    const sidebarClient = createSettingsAnsweringClient({
        agentId: "theme-sidebar-id",
        workspace: "/work/vera",
        model: "sidebar-model",
        mode: "auto",
        initialUpdates: [{
            type: "history",
            entries: [{ kind: "assistant", text: "SIDEBAR THEME TEXT" }],
            seq: 0,
        }],
    });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => ({
            ...scenario.dependencies,
            attachAgent: async () => sidebarClient,
        }),
    });

    try {
        await session.waitForVisiblePane("SIDEBAR THEME TEXT");

        session.sendText("/themes");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Theme");
        session.sendText("owl");
        await session.settle(250);
        const sidebarTextColor = (): number[] | undefined => {
            const line = session.captureSpans().lines.find((candidate) =>
                candidate.spans.map((span) => span.text).join("")
                    .includes("SIDEBAR THEME TEXT")
            );
            return line?.spans.find((span) => span.text.includes("SIDEBAR"))
                ?.fg.toInts();
        };
        const behindScrim = (color: string): number[] => {
            const [red = 0, green = 0, blue = 0] = RGBA.fromHex(color).toInts();
            const visible = (channel: number): number =>
                Math.round(channel * (255 - 150) / 255);
            return [visible(red), visible(green), visible(blue), 255];
        };
        expect(sidebarTextColor()).toEqual(
            behindScrim(themeCatalog.themes.nightowl.text),
        );
        session.sendKey("BSpace");
        session.sendKey("BSpace");
        session.sendKey("BSpace");
        session.sendText("hub");
        await session.settle(250);
        expect(sidebarTextColor()).toEqual(
            behindScrim(themeCatalog.themes.github.text),
        );
        session.sendKey("Escape");
        await session.settle(250);
        const pane = await session.waitForVisiblePane("SIDEBAR THEME TEXT");
        expect(pane).toContain("SIDEBAR THEME TEXT");
        expect(sidebarTextColor()).toEqual(
            RGBA.fromHex(VERA_TUI_THEME.text).toInts(),
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+N starts a new chat and asks how to leave", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-sidebar-new-"));
    const scenario = createTuiNewSessionScenario({
        home,
        succeedFirst: true,
    });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => ({
            ...scenario.dependencies,
            listAgents: async () => [{
                id: "current-session-id",
                workspace: "/work/vera",
                session_path: "/sessions/current.jsonl",
                kind: "interactive" as const,
                status: "idle" as const,
                live: true,
                title: "The one already open",
                updated_at: new Date().toISOString(),
            }],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-n");
        await chooseCreateLeave(session, "keep_running");
        await session.waitForVisiblePane("fresh-model");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "new-session-result.txt"), "utf8")).toBe(
            "new-session-id\ndetached\nnext detached\nattempts 1\n/work/vera"
                + "\nclosed new-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("close command parks the current session as a resume file", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-close-slash-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/close");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("This conversation is idle.")
                && visible.includes("hello from disk"),
            "the parked file with resume overlay",
        );
        expect(pane).not.toContain("Start a conversation");
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8")).toBe(
            "none\ndetached\ncurrent-session-id\nclosed current-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("Ctrl+W parks the current session as a resume file", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-close-chord-"));
    const scenario = createTuiResumeScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-w");
        const pane = await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("This conversation is idle.")
                && visible.includes("hello from disk"),
            "the parked file with resume overlay",
        );
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8")).toBe(
            "none\ndetached\ncurrent-session-id\nclosed current-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);

test("closing in-flight work asks first", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-close-confirm-"));
    const scenario = createTuiResumeScenario({ home, inFlight: true });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });

    try {
        await session.waitForVisiblePane("TURN IN FLIGHT");
        session.sendKey("C-w");
        let pane = await session.waitForVisiblePane("Stop this conversation?");
        expect(pane).toContain("[1] close");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("TURN IN FLIGHT")
                && !visible.includes("Stop this conversation?"),
            "the in-flight transcript after cancel",
        );
        expect(pane).not.toContain("This conversation is idle.");
        session.sendKey("C-w");
        await session.waitForVisiblePane("[1] close");
        session.sendKey("1");
        pane = await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("This conversation is idle.")
                && visible.includes("hello from disk"),
            "the parked file after confirmed close",
        );
        session.sendKey("C-c");
        const exit = await session.waitForSessionExit();
        await scenario.finish(exit);
        expect(readFileSync(join(home, "resume-result.txt"), "utf8")).toBe(
            "none\ndetached\ncurrent-session-id\nclosed current-session-id",
        );
    } finally {
        await session.close();
    }
}, 15_000);
