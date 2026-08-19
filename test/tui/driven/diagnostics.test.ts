import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import {
    createTuiReloadFailureDependencies,
} from "../../support/tui-reload-failure-child.ts";
import {
    createTuiPartialReloadDependencies,
} from "../../support/tui-partial-reload-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("diagnostics opens as a large copyable overlay instead of transcript text", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-diagnostics-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiChildDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        // In-process input is faster than tmux keystrokes were, so give the
        // settings row the beat it needs before the overlay covers it.
        await session.waitForVisiblePane("test · HIGH");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("copy  enter");
        expect(pane).toContain("Extensions");
        expect(pane).toContain("Runtime");
        expect(pane).toContain("copy  enter");
        // The composer stays behind the overlay, and its frame carries the
        // row that says what the session is answering as.
        expect(pane).toContain("test · HIGH");

        session.sendKey("C-p");
        await session.settle(100);
        pane = session.captureVisiblePane();
        expect(pane).toContain("Build");
        expect(pane).not.toContain("Commands");

        session.sendKey("Enter");
        await session.waitForVisiblePane("✓ copied");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("Pre-image stash"),
            "diagnostics overlay to close without transcript output",
        );
        expect(pane).not.toContain("Diagnostics");
    } finally {
        await session.close();
    }
}, 15_000);

test("doctor opens the read-only process report inside the TUI", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-doctor-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiChildDependencies({ staleDoctor: true }),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/doctor");
        session.sendKey("Enter");
        await session.waitForVisiblePane("checking process health…");
        session.sendKey("Escape");
        await session.waitForVisiblePane("Message Vera");
        session.sendText("/doctor");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Result: issues found");
        expect(pane).toContain("Doctor");
        expect(pane).toContain("Process summary");
        expect(pane).toContain("Resident hosts: 1 (1 unrecognized");
        expect(pane).toContain("PID 4242");
        expect(pane).toContain("No processes were stopped.");
        await session.settle(400);
        pane = session.captureVisiblePane();
        expect(pane).toContain("PID 4242");
        expect(pane).not.toContain("PID 1111");

        session.sendKey("Enter");
        await session.waitForVisiblePane("✓ copied");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("Result: issues found"),
            "doctor overlay to close without transcript output",
        );
        expect(pane).not.toContain("Process summary");
    } finally {
        await session.close();
    }
}, 15_000);

test("reload failure reaches the TUI diagnostics overlay", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reload-failure-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiReloadFailureDependencies(home),
    });
    let pane = "";

    try {
        // An extension that fails to load reports into the transcript, so
        // the empty-state line is already gone by the time the TUI is up.
        await session.waitForVisiblePane("Message Vera");

        session.sendText("/reload-extensions");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Client extensions reloaded with failures: none",
        );

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("reload       failed");
        expect(pane).toContain("reload error");
        expect(pane).not.toContain("reload       partial");
    } finally {
        await session.close();
    }
}, 15_000);

test("partial reload names the extensions that stayed active", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-partial-reload-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiPartialReloadDependencies(home),
    });
    let pane = "";

    try {
        // An extension that fails to load reports into the transcript, so
        // the empty-state line is already gone by the time the TUI is up.
        await session.waitForVisiblePane("Message Vera");

        session.sendText("/reload-extensions");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Client extensions reloaded with failures: some",
        );

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("reload       partial (1 loaded)");
        expect(pane).toContain("active       test.sidebar");
        expect(pane).toContain("reload error");
    } finally {
        await session.close();
    }
}, 15_000);
