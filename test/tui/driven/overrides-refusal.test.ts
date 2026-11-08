import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiSettingsDependencies,
} from "../../support/tui-settings-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("a lever that contradicts another is refused in the pane", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-overrides-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiSettingsDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");

        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Overrides");
        session.sendText("Overrides");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Tool result budget");
        session.sendText("Tool result budget");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("results are stubbed early");

        // 16k for every result is under the 64k one result may carry, which
        // is a config that does not load, so the pane says no before writing.
        session.sendText("16k");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "A 16k total budget is under the 64k one-result ceiling.",
        );
        // The pane it was turned down in is the pane it is still on.
        expect(pane).toContain("Tool result budget");
        expect(pane).toContain("Not set");
        expect(existsSync(join(home, ".vera", "config.json"))).toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);

test("the tool-result caution remains readable in a narrow pane", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-overrides-caution-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 35,
        dependencies: () => createTuiSettingsDependencies({
            contextWindow: 8_192,
            configured: { toolResultCeilingBytes: 65_536 },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Overrides");
        session.sendText("Overrides");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Tool result ceiling");
        session.sendText("Tool result");
        let pane = await session.waitForVisiblePane("65,536-byte ceiling");
        expect(pane).toContain("32,768 total bytes.");
        expect(pane).toContain("caution");

        session.resize(80, 35);
        pane = await session.waitForVisiblePane("65,536-byte ceiling");
        expect(pane).toContain("32,768 total bytes.");
        session.sendKey("Down");
        pane = await session.waitForVisiblePane("65,536-byte ceiling");
        expect(pane).toContain("32,768 total bytes.");
    } finally {
        await session.close();
    }
}, 20_000);

test("a trigger under the summary target is saved only after the user agrees", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-overrides-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiSettingsDependencies(),
    });
    const config = join(home, ".vera", "config.json");
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");

        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Overrides");
        session.sendText("Overrides");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Compaction trigger");
        session.sendText("Compaction trigger");
        session.sendKey("Enter");
        await session.waitForVisiblePane("fires early");

        session.sendText("0.30");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Save a target that is not under the trigger?",
        );
        expect(pane).toContain("A 0.45 summary target is not under the 0.30");
        expect(existsSync(config)).toBe(false);

        // Escape leaves the value list as it was, filter included.
        session.sendKey("Escape");
        pane = await session.waitForVisiblePane("fires early");
        expect(pane).not.toContain("Save a target");
        expect(existsSync(config)).toBe(false);

        session.sendKey("Enter");
        await session.waitForVisiblePane(
            "Save a target that is not under the trigger?",
        );
        session.sendText("1");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => /Compaction trigger +0\.30 +set/.test(visible),
            "the trigger saved at 0.30",
        );
        expect(pane).not.toContain("Save a target");
    } finally {
        await session.close();
    }
}, 20_000);
