import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiImageDropDependencies } from "../../support/tui-image-drop-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

// A 1x1 PNG, so materializeDroppedImage has real bytes to copy.
const PNG_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

test("a dropped image attaches and hands the composer back its focus", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-image-drop-"));
    const imagePath = join(home, "dropped.png");
    writeFileSync(imagePath, PNG_BYTES);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiImageDropDependencies(),
    });

    try {
        const pane = await session.waitForVisiblePane("Drop a file anywhere");
        const row = pane.split("\n")
            .findIndex((line) => line.includes("Drop a file anywhere"));
        expect(row).toBeGreaterThanOrEqual(0);

        // A Finder drag crosses the transcript before the terminal pastes the
        // path. The transcript takes focus on the mouse down, so the drop has
        // to attach anyway and put focus back on the composer.
        await session.sendMouseDrag(30, row, 60, row);
        await session.settle(200);
        await session.sendPaste(imagePath);
        await session.waitForVisiblePane("[Image 1]");

        // No "i" to reclaim focus: typing must land in the composer.
        session.sendText("typed after drop");
        const after = await session.waitForVisiblePane("typed after drop");
        expect(after).toContain("[Image 1]");
    } finally {
        await session.close();
    }
}, 15_000);

test("a pasted image path attaches once when the composer already has focus", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-image-paste-"));
    const imagePath = join(home, "dropped.png");
    writeFileSync(imagePath, PNG_BYTES);
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 30,
        dependencies: () => createTuiImageDropDependencies(),
    });

    try {
        await session.waitForVisiblePane("Drop a file anywhere");
        await session.sendPaste(imagePath);
        await session.waitForVisiblePane("[Image 1]");
        await session.settle(200);

        // The global paste handler and the composer's own handler both see the
        // paste; only one may attach it.
        const pane = session.captureVisiblePane();
        expect(pane).toContain("[Image 1]");
        expect(pane).not.toContain("[Image 2]");
    } finally {
        await session.close();
    }
}, 15_000);
