import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiRewindDependencies,
} from "../../support/tui-rewind-child.ts";
import {
    createTuiRewindFailureDependencies,
} from "../../support/tui-rewind-failure-child.ts";
import {
    createTuiForkSessionScenario,
} from "../../support/tui-fork-session-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("rewind picker preserves global Ctrl-C and restores focus after failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-rewind-edges-"));

    const failure = await startTuiTestSession({
        home,
        dependencies: () => createTuiRewindFailureDependencies(),
    });
    try {
        await failure.waitForVisiblePane("Start a conversation");
        failure.sendText("/rewind");
        failure.sendKey("Enter");
        await failure.waitForVisiblePane("timeline unavailable");
        failure.sendText("composer works");
        expect(await failure.waitForVisiblePane("composer works"))
            .toContain("composer works");
    } finally {
        await failure.close();
    }

    const interrupt = await startTuiTestSession({
        home,
        dependencies: () => createTuiRewindDependencies(),
    });
    try {
        await interrupt.waitForVisiblePane("Start a conversation");
        interrupt.sendText("/rewind");
        interrupt.sendKey("Enter");
        await interrupt.waitForVisiblePane("Rewind: select a point");
        interrupt.sendKey("C-c");
        await interrupt.waitForSessionExit();
    } finally {
        await interrupt.close();
    }
}, 15_000);

function occurrences(text: string, value: string): number {
    return text.split(value).length - 1;
}

test("real TUI previews and confirms conversation-only rewind", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-rewind-test-"));
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
        session.sendText("second request");
        session.sendKey("Enter");
        await session.waitForVisiblePane("SECOND ANSWER");

        session.sendText("/rew");
        // Description padding is computed over the matching commands, so once
        // the filter settles on one row there is nothing to pad to. The wide
        // form this used to expect is the unfiltered list, which is only on
        // screen for the instant between "/" and "rew" being typed.
        pane = await session.waitForVisiblePane(
            "/rewind  Rewind the active conversation",
        );
        session.sendKey("Tab");
        pane = await session.waitForVisiblePaneWhere(
            (current) => occurrences(current, "/rewind") >= 2,
            "completed /rewind command",
        );
        session.sendKey("Enter");
        pane = await session.waitForVisiblePaneWhere(
            // The transcript behind the overlay also carries "second request",
            // so the timeline has only loaded once its own footer is on
            // screen.
            (current) => current.includes("Rewind: select a point")
                && current.includes(
                    "Workspace files and external effects will not change",
                ),
            "loaded rewind timeline",
        );
        expect(pane).toContain("Rewind: select a point");
        expect(pane).toContain("second request");
        expect(pane).toContain(
            "Workspace files and external effects will not change",
        );

        session.sendKey("Enter");
        await session.waitForVisiblePane("Rewind conversation");
        session.sendText("1");
        pane = await session.waitForVisiblePane("Confirm rewind");
        expect(pane).toContain("Files         unchanged");
        expect(pane).toContain("External work unchanged");

        session.sendKey("Enter");
        await session.settle(100);
        expect(session.captureVisiblePane()).toContain("Confirm rewind");

        session.sendText("1");
        pane = await session.waitForVisiblePaneWhere(
            (current) => current.includes("FIRST ANSWER")
                && !current.includes("SECOND ANSWER")
                && !current.includes("Confirm rewind"),
            "rewound transcript",
        );
        expect(pane).toContain("first request");
        expect(occurrences(pane, "second request")).toBe(1);
    } finally {
        await session.close();
    }
}, 15_000);

test("tab picks the highlighted command without running it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-command-tab-"));
    const scenario = createTuiForkSessionScenario({ home });
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => scenario.dependencies,
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/");
        await session.waitForVisiblePane("/fork");
        // Nothing chosen yet: the first row is where the list opened, not
        // a pick, so completing takes no command.
        session.sendKey("Tab");
        await session.settle(200);
        pane = session.captureVisiblePane();
        expect(pane).toContain("Rewind the active conversation");

        session.sendKey("Down");
        session.sendKey("Tab");
        // Typed, not run: a command that takes an argument is not
        // finished being typed when it is chosen.
        pane = await session.waitForVisiblePaneWhere(
            (visible) =>
                visible.includes("/fork")
                && !visible.includes("Rewind the active conversation"),
            "the chosen command alone in the composer",
        );
    } finally {
        await session.close();
    }
}, 15_000);
