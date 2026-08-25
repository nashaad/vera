import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the config editor action opens the editor and explains when changes apply", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-config-editor-"));
    let editorOpenings = 0;
    let closeEditor: (() => void) | undefined;
    const editorClosed = new Promise<void>((resolve) => {
        closeEditor = resolve;
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...createTuiChildDependencies(),
            openConfigure: async () => {
                editorOpenings += 1;
                await editorClosed;
            },
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("open config file");
        const palette = await session.waitForVisiblePane("Open config file");
        expect(palette.replace(/\s+/g, " ")).toContain(
            "edit Vera's provider and model defaults",
        );
        session.sendKey("Enter");
        await session.settle(100);
        expect(editorOpenings).toBe(1);
        expect(session.captureVisiblePane()).not.toContain(
            "Configure editor closed.",
        );
        closeEditor!();

        const pane = await session.waitForVisiblePane(
            "Configure editor closed.",
        );
        const notice = pane.replace(/\s+/g, " ");
        expect(notice).toContain("Settings apply to new sessions");
        expect(notice).toContain("changed extension list needs a restart");
    } finally {
        closeEditor?.();
        await session.close();
    }
}, 15_000);

test("All settings routes raw rows to their owning file and explains restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-settings-catalog-"));
    let openedPath: string | undefined;
    let closeEditor: (() => void) | undefined;
    const editorClosed = new Promise<void>((resolve) => {
        closeEditor = resolve;
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...createTuiChildDependencies(),
            openFile: async (path: string) => {
                openedPath = path;
                await editorClosed;
            },
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/settings");
        session.sendKey("Enter");
        await session.waitForVisiblePane("All settings");
        session.sendText("transcript and composer");
        session.sendKey("Enter");
        await session.settle(100);
        expect(openedPath).toBeDefined();
        expect(openedPath!).toContain("config.json");
        expect(session.captureVisiblePane()).not.toContain("Editor closed");
        closeEditor!();
        const pane = await session.waitForVisiblePane("Editor closed");
        const notice = pane.replace(/\s+/g, " ");
        expect(notice).toContain("Apply: client restart");
        expect(notice).toContain("Restart Vera outside this TUI");
    } finally {
        closeEditor?.();
        await session.close();
    }
}, 15_000);
