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
        session.sendKey("Enter");
        await session.waitForVisiblePane("already shortlisted");
        expect(commands.filter((command) => command.type === "pool_add"))
            .toHaveLength(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("shortlist verification stays visible above the dimmed prose", async () => {
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
            "Verifying openrouter/one/model…",
        );
        const verifyingLines = verifying.split("\n").filter((line) =>
            line.includes("Verifying openrouter/one/model")
        );
        expect(verifyingLines).toHaveLength(2);
        expect(verifyingLines.some((line) =>
            line.indexOf("Verifying") > 50
        )).toBe(true);
        expect(verifyingLines.some((line) =>
            line.indexOf("Verifying") < 20
        )).toBe(true);

        const finished = await session.waitForVisiblePane(
            "Name shortlisted model",
        );
        expect(finished).toContain("Pinned to your shortlist");
        expect(finished).not.toContain("Verifying openrouter/one/model…");
        // The durable admission prose remains after the live toast clears.
        expect(finished).toContain("Verifying openrouter/one/model");
    } finally {
        await session.close();
    }
}, 15_000);
