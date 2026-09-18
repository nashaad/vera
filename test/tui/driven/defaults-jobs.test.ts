import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiCatalogRefreshDependencies,
} from "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the manage menu reaches the defaults, which name the job slots", async () => {
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
        session.sendText("/models");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Browse models");
        // Ctrl+K is the browse page's own menu; the defaults live under it.
        session.sendKey("C-k");
        await session.waitForVisiblePane("Manage models");
        session.sendKey("Down");
        session.sendKey("Down");
        await session.waitForVisiblePane("Choose models for roles");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Assign model defaults");
        expect(pane).toContain("classifier");
        expect(pane).not.toMatch(/^.*reviewer.*uses session/m);
        expect(pane).toContain("compaction");
        expect(pane).toContain("subagents");
    } finally {
        await session.close();
    }
}, 15_000);

test("the palette opens Favorites with the current model ready to add", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-library-action-"));
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
        session.sendText("favorites");
        await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter");
        const opened = await session.waitForVisiblePane("Favorites (0)");
        // Empty favorites are not a dead end: the running model is on the list
        // with the key that keeps it.
        expect(opened).toContain("Add to favorites");
        expect(opened).toContain("Favorites: not saved");
        expect(opened).not.toContain("^s pin");
    } finally {
        await session.close();
    }
}, 15_000);

test("opening favorites on an already-kept model adds nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-library-idempotent-"));
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
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("favorites");
        await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Favorites (1)");
        expect(commands.filter((command) => command.type === "pool_add"))
            .toHaveLength(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("the switcher's favorite runs the admission in the transcript", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-admission-"));
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
        session.sendText("/model");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Switch model");
        session.sendKey("C-f");
        // The check runs in the transcript, so the switcher stays usable while
        // the host works.
        const running = await session.waitForVisiblePane(
            "Verifying openrouter/one/model",
        );
        expect(running).toContain("Adding One to favorites");
        expect(running).toContain("⏎ switch");
        await session.waitForVisiblePane("Kept in your favorites");
        const kept = await session.waitForVisiblePane("Ctrl+F unfavorite");
        // The row is under Favorites now, and it is still the current model.
        expect(kept).toMatch(/favorites\s+One\s+current/);
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Switch model"),
            "the switcher to close",
        );
    } finally {
        await session.close();
    }
}, 20_000);
