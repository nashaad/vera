import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResizeAnchorDependencies } from "../../support/tui-resize-anchor-child.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const HEIGHT = 40;
const WIDTHS = [70, 65, 72, 75, 78, 85, 40, 150];

function firstLine(pane: string): { row: number; line: string } {
    const rows = pane.split("\n");
    for (let row = 0; row < rows.length; row += 1) {
        const line = /\bLINE\d{3}\b/.exec(rows[row]!)?.[0];
        if (line !== undefined) return { row, line };
    }
    throw new Error(`No transcript line in pane:\n${pane}`);
}

test("width reflow keeps the top source line at every trial width", async () => {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-test-")),
        width: 120,
        height: HEIGHT,
        dependencies: createResizeAnchorDependencies,
    });
    try {
        await session.waitForVisiblePane("LINE300");
        for (let press = 0; press < 14; press += 1) {
            session.sendKey("C-u");
            await session.settle(35);
        }
        await session.settle(150);
        const before = firstLine(session.captureVisiblePane());
        for (const width of WIDTHS) {
            session.resize(width, HEIGHT);
            await session.settle(150);
            await session.settle(150);
            expect(firstLine(session.captureVisiblePane())).toEqual(before);
            session.resize(120, HEIGHT);
            await session.settle(150);
            await session.settle(150);
            expect(firstLine(session.captureVisiblePane())).toEqual(before);
        }

        session.sendKeyWithModifiers("down", { ctrl: true });
        await session.settle(100);
        expect(firstLine(session.captureVisiblePane()).line).toBe("LINE115");
        session.sendKeyWithModifiers("down", { ctrl: true });
        await session.settle(100);
        const continuation = session.captureVisiblePane().split("\n")[1]!;
        expect(continuation).toContain("wrap-marker-115");
        for (const height of [30, 20, HEIGHT]) {
            session.resize(120, height);
            await session.settle(150);
            expect(session.captureVisiblePane().split("\n")[1]).toBe(continuation);
        }
        session.resize(70, HEIGHT);
        await session.settle(150);
        await session.settle(150);
        expect(session.captureVisiblePane().split("\n")[1])
            .toBe("  barnacles on the keel, rumours in the crow's nest and again");
        session.resize(120, HEIGHT);
        await session.settle(150);
        await session.settle(150);
        expect(session.captureVisiblePane().split("\n")[1]).toBe(continuation);
    } finally {
        await session.close();
    }
}, 60_000);

test("widening near the bottom keeps the source line at the top", async () => {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-test-")),
        width: 40,
        height: HEIGHT,
        dependencies: createResizeAnchorDependencies,
    });
    try {
        await session.waitForVisiblePane("LINE300");
        session.sendKey("C-u");
        await session.settle(150);
        for (let step = 0; step < 5 && !session.captureVisiblePane().split("\n")[1]!.includes("LINE"); step += 1) {
            session.sendKeyWithModifiers("up", { ctrl: true });
            await session.settle(50);
        }
        const before = firstLine(session.captureVisiblePane());
        expect(before.row).toBe(1);
        session.resize(150, HEIGHT);
        await session.settle(150);
        await session.settle(150);
        expect(firstLine(session.captureVisiblePane())).toEqual(before);
        expect(session.captureVisiblePane()).toContain("Jump to bottom");
        for (const width of [40, 150]) {
            session.resize(width, HEIGHT);
            await session.settle(150);
            await session.settle(150);
            expect(firstLine(session.captureVisiblePane())).toEqual(before);
        }
        for (const height of [30, 20, HEIGHT]) {
            session.resize(150, height);
            await session.settle(150);
            expect(firstLine(session.captureVisiblePane())).toEqual(before);
        }
        session.sendKeyWithModifiers("end", { ctrl: true });
        await session.settle(150);
        await session.settle(150);
        expect(session.captureVisiblePane()).toContain("LINE300");
        expect(session.captureVisiblePane()).not.toContain("Jump to bottom");
        expect(firstLine(session.captureVisiblePane()).line).not.toBe(before.line);
        session.resize(40, HEIGHT);
        await session.settle(150);
        expect(session.captureVisiblePane()).toContain("LINE300");
        expect(session.captureVisiblePane()).not.toContain("Jump to bottom");

        session.sendKey("C-u");
        await session.settle(150);
        session.resize(150, HEIGHT);
        await session.settle(150);
        await session.settle(150);
        await session.sendMouseWheel("down", 10, 10);
        await session.settle(200);
        await session.settle(200);
        expect(session.captureVisiblePane()).toContain("LINE300");
        expect(session.captureVisiblePane()).not.toContain("Jump to bottom");
    } finally {
        await session.close();
    }
}, 30_000);

test("source lines remain anchored inside fenced code and user messages", async () => {
    const lines = Array.from({ length: 300 }, (_, index) => {
        const tag = `ROW${String(index + 1).padStart(3, "0")}`;
        const phrase = "the pirate crow checks the harbour ledger";
        return `${tag} ${phrase}${index % 5 === 0 ? ` ${phrase} ${phrase}` : ""}`;
    }).join("\n");
    for (const kind of ["assistant", "user"] as const) {
        const text = kind === "assistant" ? `# Deck log\n\n\`\`\`text\n${lines}\n\`\`\`` : lines;
        const session = await startTuiTestSession({
            home: mkdtempSync(join(tmpdir(), "vera-tui-test-")),
            width: 120,
            height: HEIGHT,
            dependencies: () => ({
                client: createSettingsAnsweringClient({
                    agentId: `resize-${kind}`,
                    model: "resize-anchor-model",
                    mode: "auto",
                    initialUpdates: [{ type: "history", entries: [{ kind, text }], seq: 0 }],
                }),
                listAgents: async () => [],
            }),
        });
        try {
            await session.waitForVisiblePane("ROW300");
            for (let press = 0; press < 10; press += 1) {
                session.sendKey("C-u");
                await session.settle(30);
            }
            for (let step = 0; step < 8 && !/ROW\d{3}/.test(session.captureVisiblePane().split("\n")[1]!); step += 1) {
                session.sendKeyWithModifiers("up", { ctrl: true });
                await session.settle(50);
            }
            const row = session.captureVisiblePane().split("\n")[1]!;
            const before = /ROW\d{3}/.exec(row)?.[0];
            expect(before).toBeDefined();
            for (const width of [70, 65, 120]) {
                session.resize(width, HEIGHT);
                await session.settle(150);
                await session.settle(150);
                expect(session.captureVisiblePane().split("\n")[1]).toContain(before!);
            }
        } finally {
            await session.close();
        }
    }
}, 30_000);
