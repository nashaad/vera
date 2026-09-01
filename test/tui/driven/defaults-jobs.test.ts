import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiCatalogRefreshDependencies,
} from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the defaults tab names the auto-approval job classifier", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-defaults-jobs-"));
    const configDirectory = join(home, ".vera");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "one/model",
    }));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/model");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Select model");
        session.sendKey("Tab");
        session.sendKey("Tab");
        const pane = await session.waitForVisiblePane("Dedicated jobs");
        expect(pane).toContain("classifier");
        expect(pane).not.toMatch(/^.*reviewer.*uses session/m);
        expect(pane).toContain("compaction");
        expect(pane).toContain("subagents");
    } finally {
        await session.close();
    }
}, 15_000);

test("the palette opens Shortlist with a visible current-model action", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-shortlist-action-"));
    const configDirectory = join(home, ".vera");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "one/model",
    }));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("shortlist");
        await session.waitForVisiblePane("Open your shortlist");
        session.sendKey("Enter");
        const opened = await session.waitForVisiblePane("Shortlist (0)");
        // An empty shortlist is not a dead end: More is the row above it.
        expect(opened).toContain("More");
        expect(opened).not.toContain("Add current model to shortl");

        session.sendKey("Up");
        session.sendKey("Right");
        const pane = await session.waitForVisiblePane(
            "Add current model",
        );
        expect(pane).toContain("Shortlist (0)");
        expect(pane).not.toContain("^s pin");
    } finally {
        await session.close();
    }
}, 15_000);

test("shortlist is idempotent when the current model is already kept", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-shortlist-idempotent-"));
    const commands: Array<{ readonly type: string }> = [];
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiCatalogRefreshDependencies({
            pooled: [{
                provider: "openrouter",
                model: "one/model",
                label: "One",
                poolName: "primary",
                available: true,
                verified: false,
                levels: [],
            }],
            onCommand: (command) => commands.push(command),
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/shortlist");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.split("\n").some((line) =>
                line.includes("│ /shortlist")
            ),
            "the complete /shortlist command in the composer",
        );
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.split("\n").some((line) =>
                line.includes("│ /shortlist")
            ),
            "the idempotent /shortlist command to clear the composer",
        );
        expect(commands.filter((command) => command.type === "pool_add"))
            .toHaveLength(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("shortlist verification runs in a console inside the model dialog", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-shortlist-toast-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 40,
        dependencies: () => createTuiCatalogRefreshDependencies({
            poolAdmissionDelayMs: 750,
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("shortlist");
        await session.waitForVisiblePane("Open your shortlist");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Shortlist (0)");
        session.sendKey("Up");
        session.sendKey("Right");
        await session.waitForVisiblePane("Add current model");
        session.sendKey("Enter");

        const subject = "Verifying openrouter/one/model";
        // Two of them while the check runs: the transcript's record of it, and
        // the console inside the pane.
        const verifying = await session.waitForVisiblePaneWhere(
            (pane) =>
                pane.split("\n").filter((line) => line.includes(subject))
                    .length === 2,
            "the verification console to open",
        );
        const lines = verifying.split("\n");
        const consoleLine = lines.findLastIndex((line) =>
            line.includes(subject)
        );
        expect(consoleLine).toBeGreaterThan(0);
        // The running check carries the spinner; nothing else does.
        expect(lines[consoleLine + 1]).toContain("⠋ ");
        const consoleColumn = lines[consoleLine]!.indexOf("Verifying");
        const consoleWidth = subject.length;
        expect(lines[consoleLine - 1]?.slice(
            consoleColumn,
            consoleColumn + consoleWidth,
        )).not.toMatch(/[╭─]/);

        const finished = await session.waitForVisiblePane(
            "Name shortlisted model",
        );
        expect(finished).toContain("Pinned to your shortlist");
        // The durable admission prose remains after the live console clears.
        expect(finished.split("\n").filter((line) => line.includes(subject)))
            .toHaveLength(1);

        session.sendKey("Escape");
        await session.waitForVisiblePane("More");
        // Leaving More returns to the entry row; Down steps onto the model.
        session.sendKey("Left");
        session.sendKey("Down");
        session.sendKey("Right");
        await session.waitForVisiblePane("Verify this model");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(
            (pane) =>
                pane.split("\n").filter((line) => line.includes(subject))
                    .length === 3,
            "the console to reopen for the second check",
        );
        await session.waitForVisiblePaneWhere(
            (pane) =>
                pane.includes("Verify this model")
                && pane.split("\n").filter((line) => line.includes(subject))
                        .length === 2,
            "inspector verification to finish",
        );
        session.sendKey("Left");
        await session.waitForVisiblePane("^d^u move");
        session.sendKey("Up");
        await session.waitForVisiblePane("→ open");
        session.sendKey("Enter");
        const page = await session.waitForVisiblePane(
            "Verify shortlisted models",
        );
        // Verifying the whole shortlist is a thing the list does, so More is
        // where it is now reached from.
        expect(page).not.toContain("Verify all (1)");
        session.sendKey("Escape");
        await session.waitForVisiblePane("→ open");
        session.sendKey("Tab");
        await session.waitForVisiblePane("Everything your providers offer");
        session.sendKey("Tab");
        await session.waitForVisiblePane("Refresh model catalog from pr");
        session.sendKey("Enter");
        const refreshScope = await session.waitForVisiblePane(
            "Refresh model catalog from providers",
        );
        expect(refreshScope).toContain("openrouter");
    } finally {
        await session.close();
    }
}, 15_000);
