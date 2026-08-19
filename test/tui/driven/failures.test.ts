import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createTuiConnectionErrorDependencies,
} from "../../support/tui-connection-error-child.ts";
import {
    createTuiFatalDiagnosticDependencies,
} from "../../support/tui-fatal-diagnostic-child.ts";
import {
    createTuiTerminalErrorDependencies,
} from "../../support/tui-terminal-error-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function occurrences(text: string, value: string): number {
    return text.split(value).length - 1;
}

test("resident stream failure becomes a recoverable disconnected TUI", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-connection-error-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiConnectionErrorDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane(
            "disconnected: Host sent a non-contiguous agent",
        );
        expect(pane).not.toContain("Connection error");
        expect(pane).toContain("· /reconnect host · ctrl+c quit");
        expect(pane).not.toContain("working…");
        expect(pane).not.toContain("stopping");

        session.sendText("/reconnect");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Host reconnected.");
        expect(pane).toContain("ready · ctrl+p commands");
        expect(pane).not.toContain("/reconnect host");

        session.sendText("/themes");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Theme");
        expect(pane).toContain("System");

        session.sendKey("Escape");
        await session.settle(50);
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("resident agent death renders as a separated fatal diagnostic", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-fatal-diagnostic-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiFatalDiagnosticDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane(
            "Resident agent stopped unexpectedly",
        );
        expect(pane).toMatch(
            /^ {2}× stopped  Resident agent stopped unexpectedly$/m,
        );
        expect(pane).toMatch(
            /^ {2}× Reviewer denied bash \(high risk\): The permission gate denied this operation\.$/m,
        );
        expect(pane).toMatch(
            /Reviewer denied bash[^\n]*\n[^\S\n]*\n {2}× stopped/,
        );
        expect(pane).not.toContain("# Agent error");
    } finally {
        await session.close();
    }
}, 15_000);

test("terminal model errors remain visible after tools and the next turn works", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-terminal-error-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiTerminalErrorDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("inspect then answer");
        session.sendKey("Enter");

        pane = await session.waitForVisiblePane(
            "Model error: Model returned no visible response or structured tool call.",
        );
        expect(pane).toMatch(
            /Explored {2}Read package\.json\s+ctrl\+e details/,
        );

        session.sendText("try again");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("RECOVERED AFTER ERROR");
        expect(pane).toContain("try again");

        session.sendKey("Up");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => occurrences(visible, "try again") >= 2,
            "the last submitted message in the composer",
        );
        expect(occurrences(pane, "try again")).toBeGreaterThanOrEqual(2);
    } finally {
        await session.close();
    }
}, 15_000);
