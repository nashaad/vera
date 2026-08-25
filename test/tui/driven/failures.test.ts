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

test("resident stream failure auto-reconnects without /reconnect", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-connection-error-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiConnectionErrorDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("Host reconnected.");
        expect(pane).toContain("ready · ctrl+p commands");
        expect(pane).not.toContain("disconnected:");
        expect(pane).not.toContain("/reconnect ·");
        expect(pane).not.toContain("Connection error");
        expect(pane).not.toContain("working…");

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

test("resident stream failure shows restarting host while reconnecting", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-restarting-host-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiConnectionErrorDependencies({
            reconnectDelayMs: 250,
        }),
    });

    try {
        const restarting = await session.waitForVisiblePane("restarting host…");
        expect(restarting).not.toContain("disconnected:");
        expect(restarting).not.toContain("working…");

        const pane = await session.waitForVisiblePane("Host reconnected.");
        expect(pane).toContain("ready · ctrl+p commands");
        expect(pane).not.toContain("restarting host…");
        expect(pane).not.toContain("/reconnect ·");
    } finally {
        await session.close();
    }
}, 15_000);

test("failed auto-reconnect stays disconnected and /reconnect still works", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reconnect-retry-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiConnectionErrorDependencies({
            reconnectFailures: 1,
        }),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("disconnected: could not start host");
        expect(pane).toContain("· /reconnect · ctrl+c quit");
        expect(pane).not.toContain("working…");
        expect(pane).not.toContain("stopping");

        session.sendText("/reconnect");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Host reconnected.");
        expect(pane).toContain("ready · ctrl+p commands");
        expect(pane).not.toContain("/reconnect ·");
    } finally {
        await session.close();
    }
}, 15_000);

test("a reconnected session that dies again does not restart the host in a loop", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reconnect-die-loop-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiConnectionErrorDependencies({
            reconnectDiesAgain: true,
        }),
    });

    try {
        const pane = await session.waitForVisiblePane("disconnected:");
        expect(pane).toContain("· /reconnect · ctrl+c quit");
        expect(pane).not.toContain("restarting host");
        await session.settle(200);
        const still = session.captureVisiblePane();
        expect(still).toContain("disconnected:");
        expect(still).not.toContain("restarting host");
        session.sendKey("C-c");
        await session.waitForSessionExit();
    } finally {
        await session.close();
    }
}, 15_000);

test("stream failure without reconnectSession stays disconnected", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reconnect-unavailable-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiConnectionErrorDependencies({
            reconnectUnavailable: true,
        }),
    });

    try {
        const pane = await session.waitForVisiblePane(
            "disconnected: Host sent a non-contiguous agent",
        );
        expect(pane).toContain("· /reconnect · ctrl+c quit");
        expect(pane).not.toContain("Host reconnected.");
        expect(pane).not.toContain("working…");
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

test("host shutdown after agent death becomes recoverable disconnection", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-failed-host-stop-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiFatalDiagnosticDependencies({
            disconnectAfterFailure: true,
        }),
    });

    try {
        const pane = await session.waitForVisiblePane(
            "disconnected: host connection closed",
        );
        expect(pane).toContain("Resident agent stopped unexpectedly");
        expect(pane).toContain("· /reconnect · ctrl+c quit");
    } finally {
        await session.close();
    }
}, 15_000);

test("agent death does not restart the host in a loop", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-failed-no-reconnect-loop-"));
    let reconnects = 0;
    const session = await startTuiTestSession({
        home,
        dependencies: () => createTuiFatalDiagnosticDependencies({
            disconnectAfterFailure: true,
            reconnectSession: async () => {
                reconnects += 1;
                throw new Error("should not auto-reconnect after agent death");
            },
        }),
    });

    try {
        const pane = await session.waitForVisiblePane(
            "disconnected: host connection closed",
        );
        expect(pane).toContain("Resident agent stopped unexpectedly");
        expect(pane).toContain("· /reconnect · ctrl+c quit");
        expect(pane).not.toContain("restarting host");
        expect(reconnects).toBe(0);
        session.sendKey("C-c");
        await session.waitForSessionExit();
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
            /Explored {2}Read package\.json\s+ctrl\+t details/,
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
