import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeRenderable, ScrollBoxRenderable, type CliRenderer } from "@opentui/core";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";

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

async function open(
    entries: HistoryEntry[],
    width: number,
    ready: string,
    onRenderer?: (renderer: CliRenderer) => void,
) {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-test-")),
        width,
        height: HEIGHT,
        dependencies: (renderer) => {
            onRenderer?.(renderer);
            return {
                client: createSettingsAnsweringClient({
                    agentId: "resize-anchor-session",
                    workspace: "/work/vera",
                    model: "resize-anchor-model",
                    mode: "review",
                    initialUpdates: [{ type: "history", entries, seq: 0 }],
                }),
                listAgents: async () => [],
            };
        },
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

test("a resize keeps the captured column of a wrapped source line", async () => {
    const entries: HistoryEntry[] = [];
    for (let n = 0; n < 4; n += 1) {
        entries.push({ kind: "user", text: `q${n}` });
        entries.push({ kind: "assistant", text: words(n * 2000, 2000) });
    }
    let renderer: CliRenderer | undefined;
    const session = await open(entries, 120, "w7999", (value) => { renderer = value; });
    try {
        await scrollUp(session, 7);
        const transcript = renderer?.root.findDescendantById("transcript");
        const code = renderer?.root.findDescendantById("entry-7-block-0");
        if (!(transcript instanceof ScrollBoxRenderable) || !(code instanceof CodeRenderable)) {
            throw new Error("Transcript text is unavailable");
        }
        const visualRow = (): number => transcript.viewport.screenY - code.screenY + code.scrollY;
        const initialRow = visualRow();
        const line = code.lineInfo.lineSources[initialRow]!;
        const column = code.lineInfo.lineStartCols[initialRow]!;
        const before = session.captureVisiblePane().split("\n")[1];
        expect(column).toBeGreaterThan(0);

        for (const width of [70, 120, 65, 120, 72, 120]) {
            const pane = await resizeTo(session, width);
            const info = code.lineInfo;
            let expected = -1;
            for (let row = 0; row < info.lineSources.length; row += 1) {
                if (info.lineSources[row] === line && info.lineStartCols[row]! <= column) expected = row;
            }
            expect(visualRow()).toBe(expected);
            expect(topRow(pane, /w(\d{4})/g).first).toBe(6000 + info.lineStartCols[expected]! / 6);
            if (width === 120) expect(pane.split("\n")[1]).toBe(before);
        }

        await resizeTo(session, 70);
        session.sendKeyWithModifiers("up", { ctrl: true });
        await session.settle(100);
        const scrolledRow = visualRow();
        const scrolledColumn = code.lineInfo.lineStartCols[scrolledRow]!;
        const scrolledText = session.captureVisiblePane().split("\n")[1];
        await resizeTo(session, 120);
        const afterScroll = code.lineInfo;
        const expected = afterScroll.lineSources.findLastIndex((source, row) =>
            source === line && afterScroll.lineStartCols[row]! <= scrolledColumn);
        expect(visualRow()).toBe(expected);
        expect((await resizeTo(session, 70)).split("\n")[1]).toBe(scrolledText);

        await session.sendMouseWheel("up", 10, 5);
        await session.settle(100);
        const wheelRow = visualRow();
        const wheelColumn = code.lineInfo.lineStartCols[wheelRow]!;
        const wheelText = session.captureVisiblePane().split("\n")[1];
        expect(wheelColumn).toBeLessThan(scrolledColumn);
        await resizeTo(session, 120);
        const afterWheel = code.lineInfo;
        const wheelExpected = afterWheel.lineSources.findLastIndex((source, row) =>
            source === line && afterWheel.lineStartCols[row]! <= wheelColumn);
        expect(visualRow()).toBe(wheelExpected);
        expect((await resizeTo(session, 70)).split("\n")[1]).toBe(wheelText);
    } finally {
        await session.close();
    }
}, 120_000);

test("a transcript change resets the captured resize column", async () => {
    const entries: HistoryEntry[] = [];
    for (let n = 0; n < 4; n += 1) {
        entries.push({ kind: "user", text: `q${n}` });
        entries.push({ kind: "assistant", text: words(n * 2000, 2000) });
    }
    let push: ((update: AgentUpdate) => void) | undefined;
    const client = createSettingsAnsweringClient({
        agentId: "resize-change-session",
        model: "resize-anchor-model",
        mode: "auto",
        initialUpdates: [{ type: "history", entries, seq: 0 }],
        onCommand: (_, emit) => { push = emit; },
    });
    await client.send({ type: "prompt", content: "register" });
    let renderer: CliRenderer | undefined;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-test-")),
        width: 120,
        height: HEIGHT,
        dependencies: (value) => {
            renderer = value;
            return { client, listAgents: async () => [] };
        },
    });
    try {
        await session.waitForVisiblePane("w7999");
        await scrollUp(session, 7);
        const transcript = renderer?.root.findDescendantById("transcript");
        const code = renderer?.root.findDescendantById("entry-7-block-0");
        if (!(transcript instanceof ScrollBoxRenderable) || !(code instanceof CodeRenderable) || push === undefined) {
            throw new Error("Transcript text is unavailable");
        }
        const visualRow = (): number => transcript.viewport.screenY - code.screenY + code.scrollY;
        const oldColumn = code.lineInfo.lineStartCols[visualRow()]!;
        await resizeTo(session, 70);
        const line = code.lineInfo.lineSources[visualRow()]!;
        const newColumn = code.lineInfo.lineStartCols[visualRow()]!;
        expect(newColumn).toBeLessThan(oldColumn);
        push({ type: "assistant_delta", text: " updated", seq: 1 });
        for (let attempt = 0; attempt < 50 && !code.content.endsWith(" updated"); attempt += 1) {
            await session.settle(30);
        }
        expect(code.content.endsWith(" updated")).toBe(true);
        await resizeTo(session, 120);
        const info = code.lineInfo;
        const expected = info.lineSources.findLastIndex((source, row) =>
            source === line && info.lineStartCols[row]! <= newColumn);
        expect(visualRow()).toBe(expected);
        expect(info.lineStartCols[expected]).not.toBe(oldColumn);
    } finally {
        await session.close();
    }
}, 30_000);

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
