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
