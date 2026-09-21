import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiSettingsDependencies,
} from "../../support/tui-settings-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("clearing every lever asks first, and escape keeps them", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reset-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiSettingsDependencies(),
    });

    async function openOverrides(): Promise<void> {
        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Overrides");
        session.sendText("Overrides");
        // The filter has to land before Enter, or Enter takes whatever row
        // was highlighted when the pane opened.
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Permissions"),
            "the settings list filtered to Overrides",
        );
        session.sendKey("Enter");
        await session.waitForVisiblePane("Context limit");
    }

    async function chooseResetRow(): Promise<void> {
        session.sendText("Reset all");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Context limit"),
            "the list filtered to the reset row",
        );
        session.sendKey("Enter");
    }

    try {
        await session.waitForVisiblePane("Start a conversation");

        await openOverrides();
        session.sendText("Compaction trigger");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Context limit"),
            "the list filtered to the trigger rows",
        );
        session.sendKey("Enter");
        await session.waitForVisiblePane("fires late");
        session.sendText("0.70");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("fires early"),
            "the value list filtered to one option",
        );
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("1 set"),
            "the pane counting one lever as set",
        );

        await chooseResetRow();
        const card = await session.waitForVisiblePane(
            "Reset every override to its default?",
        );
        // The card names the lever, so the answer is not given blind.
        expect(card).toContain("Compaction trigger is set.");
        expect(card).toContain("[1] reset");
        expect(card).toContain("[esc] keep them");

        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) =>
                !pane.includes("Reset every override")
                && pane.includes("1 set"),
            "the overrides pane with the lever still set",
        );
        // The transcript is only readable once no overlay is over it.
        session.sendKey("Escape");
        await session.waitForVisiblePane("Settings");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("overrides kept")
                && !pane.includes("↑↓ move"),
            "the settings overlay to close",
        );

        // The lever survived the question being asked and answered no.
        await openOverrides();
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("1 set"),
            "the pane still counting one lever as set",
        );

        await chooseResetRow();
        await session.waitForVisiblePane("Reset every override to its default?");
        session.sendText("1");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("every lever is at its shipped default"),
            "the pane with every lever back at its default",
        );
    } finally {
        await session.close();
    }
}, 25_000);
