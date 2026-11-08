import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const HEIGHT = 30;
const WIDTHS = [80, 120, 60, 120, 96, 120, 72, 120];

interface HistoryEntry {
    kind: "user" | "assistant";
    text: string;
}

interface TopRow {
    row: number;
    first: number;
    last: number;
}

function words(from: number, count: number): string {
    return Array.from({ length: count }, (_, i) => `w${String(from + i).padStart(4, "0")}`).join(" ");
}

function lines(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(3, "0")} salt wind over the rigging`).join("\n");
}

// The first pane row that carries a numbered token, with the numbers on it.
function topRow(pane: string, token: RegExp): TopRow {
    const rows = pane.split("\n");
    for (let row = 0; row < rows.length; row += 1) {
        const numbers = [...rows[row]!.matchAll(token)].map((match) => Number(match[1]));
        if (numbers.length > 0) return { row, first: numbers[0]!, last: numbers[numbers.length - 1]! };
    }
    throw new Error(`no numbered row in pane:\n${pane}`);
}

async function open(entries: HistoryEntry[], width: number, ready: string) {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-test-")),
        width,
        height: HEIGHT,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "resize-anchor-session",
                workspace: "/work/vera",
                model: "resize-anchor-model",
                mode: "review",
                initialUpdates: [{ type: "history", entries, seq: 0 }],
            }),
            listAgents: async () => [],
        }),
    });
    await session.waitForVisiblePane(ready);
    await session.settle(150);
    return session;
}

async function scrollUp(session: Awaited<ReturnType<typeof open>>, presses: number): Promise<void> {
    for (let press = 0; press < presses; press += 1) {
        session.sendKey("C-u");
        await session.settle(30);
    }
    await session.settle(100);
}

async function resizeTo(session: Awaited<ReturnType<typeof open>>, width: number): Promise<string> {
    session.resize(width, HEIGHT);
    await session.settle(150);
    await session.settle(150);
    return session.captureVisiblePane();
}

test("a resize keeps the same wrapped text at the top of the view", async () => {
    const entries: HistoryEntry[] = [];
    for (let n = 0; n < 4; n += 1) {
        entries.push({ kind: "user", text: `q${n}` });
        entries.push({ kind: "assistant", text: words(n * 2000, 2000) });
    }
    const session = await open(entries, 120, "w7999");
    try {
        for (const presses of [7, 11, 13]) {
            await scrollUp(session, presses);
            const before = topRow(session.captureVisiblePane(), /w(\d{4})/g);
            for (const width of WIDTHS) {
                const after = topRow(await resizeTo(session, width), /w(\d{4})/g);
                expect(after.row).toBe(before.row);
                if (width === 120) {
                    expect(after.first).toBe(before.first);
                } else {
                    // A narrower row holds fewer words, so it must hold part of the old top row.
                    expect(after.first).toBeLessThanOrEqual(before.last);
                    expect(after.last).toBeGreaterThanOrEqual(before.first);
                }
            }
        }
    } finally {
        await session.close();
    }
}, 120_000);

test("a resize keeps the same line at the top when lines do not wrap", async () => {
    const entries: HistoryEntry[] = [
        { kind: "user", text: "tell me a long story" },
        { kind: "assistant", text: lines("LINE", 220) },
        { kind: "user", text: "and another" },
        { kind: "assistant", text: lines("TALE", 220) },
    ];
    const session = await open(entries, 120, "TALE220");
    try {
        for (const presses of [5, 9, 12]) {
            await scrollUp(session, presses);
            const pattern = /(?:LINE|TALE)(\d{3})/g;
            const before = topRow(session.captureVisiblePane(), pattern);
            for (const width of WIDTHS) {
                const after = topRow(await resizeTo(session, width), pattern);
                expect(after).toEqual(before);
            }
        }
    } finally {
        await session.close();
    }
}, 120_000);

test("a resize at the bottom keeps following the newest line", async () => {
    const entries: HistoryEntry[] = [
        { kind: "user", text: "tell me a long story" },
        { kind: "assistant", text: words(0, 2000) },
    ];
    const session = await open(entries, 120, "w1999");
    try {
        for (const width of WIDTHS) {
            const pane = await resizeTo(session, width);
            expect(pane).toContain("w1999");
            expect(pane).not.toContain("Jump to bottom");
        }
    } finally {
        await session.close();
    }
}, 120_000);
