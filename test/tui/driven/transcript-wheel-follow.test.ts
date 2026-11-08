import { expect, test } from "bun:test";
import { ScrollBoxRenderable, type CliRenderer } from "@opentui/core";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createResizeAnchorDependencies } from "../../support/tui-resize-anchor-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

async function open() {
    const root = "/private/tmp/vera-dev";
    mkdirSync(root, { recursive: true });
    let renderer: CliRenderer | undefined;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(root, "tuifix2-wheel-")),
        width: 120,
        height: 40,
        dependencies: (value) => {
            renderer = value;
            return createResizeAnchorDependencies();
        },
    });
    await session.waitForVisiblePane("LINE300");
    await session.settle(300);
    const transcript = renderer?.root.findDescendantById("transcript");
    if (!(transcript instanceof ScrollBoxRenderable)) {
        await session.close();
        throw new Error("Transcript is unavailable");
    }
    transcript.scrollAcceleration = { tick: () => 1, reset: () => {} };
    return { session, transcript };
}

test("one wheel step up leaves follow and keeps the row", async () => {
    const { session, transcript } = await open();
    try {
        const bottom = transcript.scrollHeight - transcript.viewport.height;
        expect(transcript.scrollTop).toBe(bottom);
        await session.sendMouseWheel("up", 20, 5);
        await session.settle(500);
        expect(transcript.scrollTop).toBe(bottom - 1);
        expect(session.captureVisiblePane()).toContain("Jump to bottom");
    } finally {
        await session.close();
    }
}, 15_000);

test("a wheel step down ending one row short resumes follow", async () => {
    const { session, transcript } = await open();
    try {
        const bottom = transcript.scrollHeight - transcript.viewport.height;
        transcript.scrollTo(bottom - 2);
        await session.settle(100);
        expect(transcript.scrollTop).toBe(bottom - 2);
        await session.sendMouseWheel("down", 20, 5);
        await session.settle(500);
        expect(transcript.scrollTop).toBe(bottom);
        expect(session.captureVisiblePane()).not.toContain("Jump to bottom");
    } finally {
        await session.close();
    }
}, 15_000);
