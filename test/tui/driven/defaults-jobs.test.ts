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
    const configDirectory = join(home, ".vera", "profiles", "default");
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
    const configDirectory = join(home, ".vera", "profiles", "default");
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
        const pane = await session.waitForVisiblePane(
            "Add current model to shortl",
        );
        expect(pane).toContain("Shortlist (0)");
        expect(pane).toContain("⏎ add");
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
        await session.waitForVisiblePane("Add current model to shortl");
        session.sendKey("Enter");

        const verifying = await session.waitForVisiblePane(
            "❯ verify openrouter/one/model",
        );
        const lines = verifying.split("\n");
        const consoleLine = lines.findIndex((line) =>
            line.includes("❯ verify openrouter/one/model")
        );
        expect(consoleLine).toBeGreaterThan(0);
        expect(lines[consoleLine + 1]).toContain(
            "⠋ waiting for provider response…",
        );
        expect(lines[consoleLine - 1]).not.toContain("╭");
        expect(lines[consoleLine + 2]).not.toContain("╰");
        expect(lines.filter((line) =>
            line.includes("Verifying openrouter/one/model")
        )).toHaveLength(1);

        const finished = await session.waitForVisiblePane(
            "Name shortlisted model",
        );
        expect(finished).toContain("Pinned to your shortlist");
        expect(finished).not.toContain("❯ verify openrouter/one/model");
        // The durable admission prose remains after the live console clears.
        expect(finished).toContain("Verifying openrouter/one/model");

        session.sendKey("Escape");
        await session.waitForVisiblePane("Verify current model");
        session.sendKey("Enter");
        await session.waitForVisiblePane("❯ verify openrouter/one/model");
        await session.waitForVisiblePaneWhere(
            (pane) =>
                pane.includes("Verify current model")
                && !pane.includes("❯ verify openrouter/one/model"),
            "repeat verification from the visible Shortlist action to finish",
        );
    } finally {
        await session.close();
    }
}, 15_000);
