import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiSettingsDependencies,
} from "../../support/tui-settings-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function profileDirectory(home: string): string {
    return join(home, ".vera", "profiles", "default");
}

test("settings picker restores the composer and the next Enter submits", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-settings-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiSettingsDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");

        session.sendText("/themes");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Theme");
        expect(pane).toContain("Night Owl");
        session.sendText("owl");
        session.sendKey("Enter");
        await session.waitForVisiblePane("theme changed: nightowl");
        expect(JSON.parse(readFileSync(
            join(profileDirectory(home), "tui.json"),
            "utf8",
        )))
            .toEqual({
                theme: "nightowl",
                animation: "conveyor",
            });

        session.sendText("/effort");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Reasoning");
        expect(pane).toContain("High");

        // The selected row is now a background highlight rather than a "›"
        // caret, so it does not show up in tmux's text-only capture. The
        // The MAX wait below is the real guard: the status line
        // only reads that way if Down moved the selection off High.
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("test · MAX");

        session.sendText("testing");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("SETTINGS TURN WORKED");
        expect(pane).toContain("testing");
    } finally {
        await session.close();
    }
}, 15_000);
