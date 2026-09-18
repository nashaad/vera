import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("real TUI queues a prompt and Escape steers to it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        // One row taller than the transcript needs, for the pane header
        // row above it, the same way startTuiSession is sized.
        height: 31,
        dependencies: () => createTuiChildDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("test · high");
        expect(pane).toContain("Start a conversation");
        expect(pane).toContain("ready · ctrl+p commands");
        expect(pane).not.toContain("shift+enter newline");
        session.sendText("start streaming");
        session.sendKey("Enter");

        pane = await session.waitForVisiblePane("esc stop");
        expect(pane).toMatch(/[░▒▓█]{7} (thinking|responding) · \d+s/);
        expect(pane).toContain("esc stop");
        expect(pane).not.toContain("enter queue");
        const workingLines = pane.split("\n");
        const activityLine = workingLines.find((line) =>
            line.includes("esc stop")
        );
        const placeLine = workingLines.find((line) =>
            line.includes("ready · ctrl+p commands")
        );
        expect(activityLine).toBeDefined();
        expect(placeLine).toBeDefined();
        if (activityLine === undefined || placeLine === undefined) {
            throw new Error("missing fixed activity or place row");
        }
        const activityLabel = Math.max(
            activityLine.indexOf("thinking"),
            activityLine.indexOf("responding"),
        );
        expect(activityLabel).toBeGreaterThanOrEqual(0);
        expect(activityLine.indexOf("esc stop")).toBeGreaterThan(
            activityLabel,
        );
        expect(activityLine).toEndWith("esc stop · ctrl+c stop");
        expect(activityLine.length).toBe(96);
        expect(workingLines.indexOf(activityLine)).toBeLessThan(
            workingLines.indexOf(placeLine),
        );

        pane = await session.waitForVisiblePane("PARTIAL xxxxx");
        expect(pane).toMatch(/[░▒▓█]{7} responding · \d+s/);
        expect(pane).toContain("esc stop");
        // This turn reasons without producing any summary text: an instant
        // phase earns no row, and a measurable one earns a row with nothing
        // behind it, so either way no fold marker appears.
        expect(pane).not.toMatch(/[▸▾] (?:Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d+\.\d+s/);
        session.sendText("redirect now");
        session.sendKey("Enter");

        pane = await session.waitForVisiblePane("queued · redirect now");
        expect(pane.split("\n").find((line) =>
            line.includes("queued · redirect now")
        )).toMatch(/^  queued · redirect now/);
        session.sendKey("Escape");

        pane = await session.waitForVisiblePane("STEER WORKED");
        expect(pane).toContain("PARTIAL xxxxx");
        expect(pane).toContain("redirect now");
        expect(pane).not.toContain("FIRST-END");
        // The estimate stands while the request is in flight, so the
        // provider's own count only replaces it once the turn ends.
        pane = await session.waitForVisiblePane("ctx ~");
        expect(pane).toContain("100%");

        // The second turn reasons, so its summary carries a fold that
        // ctrl+o opens over a row already drawn. It starts in the same
        // column as a summary with nothing behind it.
        expect(pane).toMatch(/^  Reasoning: \d+\.\d+s/m);
        expect(pane).not.toContain("WEIGHING THE ORDERINGS");
        session.sendKey("C-u");
        pane = await session.waitForVisiblePane("PARTIAL xxxxx");
        session.sendKey("C-o");
        pane = await session.waitForVisiblePane("WEIGHING THE ORDERINGS");
        expect(pane).toMatch(/Reasoning: \d+\.\d+s/);
        expect(pane).toContain("ctrl+o hide reasoning");
        expect(pane).toContain("PARTIAL xxxxx");
    } finally {
        await session.close();
    }
}, 15_000);

test("extension insertion edits the live draft without touching the queue", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-queued-compose-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({
            ...createTuiChildDependencies(),
            disabledBuiltinExtensions: [
                "vera.model-presets",
                "vera.reasoning-cycle",
            ],
            clientExtensions: [{
                path: join(
                    import.meta.dir,
                    "../../support/fixtures/compose-write-extension",
                ),
                enabled: true,
                config: {},
            }],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/compose-w");
        await session.waitForVisiblePane("Insert text into the composer");
        for (let index = 0; index < "/compose-w".length; index += 1) {
            session.sendKey("BSpace");
        }
        session.sendText("start streaming");
        session.sendKey("Enter");
        await session.waitForVisiblePane("PARTIAL xxxxx");
        session.sendText("keep this queued");
        session.sendKey("Enter");
        await session.waitForVisiblePane("queued · keep this queued");

        session.sendKey("C-k");
        const pane = await session.waitForVisiblePane("injected while queued");
        expect(pane).toContain("queued · keep this queued");
    } finally {
        await session.close();
    }
}, 15_000);

test("scrolling away from the stream offers a way back to the bottom", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-jump-bottom-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 17,
        dependencies: () => createTuiChildDependencies(),
    });
    let pane = "";

    try {
        pane = await session.waitForVisiblePane("Start a conversation");
        expect(pane).not.toContain("Jump to bottom");

        session.sendText("start streaming");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("PARTIAL xxxxx");

        for (let index = 0; index < 6; index += 1) {
            session.sendKeyWithModifiers("up", { ctrl: true });
        }
        pane = await session.waitForVisiblePane("Jump to bottom");

        session.sendKeyWithModifiers("end", { ctrl: true });
        await session.waitForVisiblePaneWhere(
            (current) => !current.includes("Jump to bottom"),
            "pill hidden after the keyboard jump",
        );

        // The wheel is the other way back, and it has to re-engage the
        // same follow the keys do.
        await session.sendMouseWheel("up", 20, 4, 10);
        pane = await session.waitForVisiblePane("Jump to bottom");
        await session.sendMouseWheel("down", 20, 4, 40);
        const reachedBottom = await session.waitForVisiblePaneWhere(
            (current) => !current.includes("Jump to bottom"),
            "pill hidden at the bottom",
        );

        // Reaching the bottom with the wheel must resume sticky follow,
        // not merely hide the pill until the next streamed update.
        const streamedBefore = (reachedBottom.match(/x/g) ?? []).length;
        const afterWheel = await session.waitForVisiblePaneWhere(
            (current) => (current.match(/x/g) ?? []).length
                    > streamedBefore + 10
                && !current.includes("Jump to bottom"),
            "stream remains followed after returning with the wheel",
        );
        expect(afterWheel).not.toContain("Jump to bottom");
    } finally {
        await session.close();
    }
}, 20_000);

test("the jump pill sits above the command suggestion strip", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-jump-strip-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 17,
        dependencies: () => createTuiChildDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");

        session.sendText("start streaming");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("PARTIAL xxxxx");

        for (let index = 0; index < 6; index += 1) {
            session.sendKeyWithModifiers("up", { ctrl: true });
        }
        pane = await session.waitForVisiblePane("Jump to bottom");

        session.sendText("/themes");
        pane = await session.waitForVisiblePaneWhere(
            (current) => /\/themes\s+Change the TUI theme/.test(current),
            "filtered theme command suggestion",
        );
        const suggestionLines = pane.split("\n");
        const suggestionRow = suggestionLines.findIndex((line) =>
            /\/themes\s+Change the TUI theme/.test(line)
        );
        const jumpRow = suggestionLines.findIndex((line) =>
            line.includes("Jump to bottom")
        );
        expect(suggestionLines[suggestionRow - 1]?.trim()).toBe("");
        expect(jumpRow).toBeLessThan(suggestionRow - 1);
    } finally {
        await session.close();
    }
}, 20_000);
