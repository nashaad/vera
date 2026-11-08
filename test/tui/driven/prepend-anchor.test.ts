import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const PHRASES = [
    "the pirate crow charts the cove at dusk",
    "salt wind over the rigging and a loose halyard",
    "ledger entries for the harbour master, none of them honest",
    "a lantern swings; the tide table says half past never",
    "barnacles on the keel, rumours in the crow's nest",
];

interface HistoryEntry {
    kind: "user" | "assistant";
    text: string;
}

function historyEntries(): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (let n = 1; n <= 30; n += 1) {
        const id = String(n).padStart(3, "0");
        const phrase = PHRASES[n % 5]!;
        out.push({ kind: "user", text: `q${id} [med]` });
        out.push({
            kind: "assistant",
            text: `MED${id} ${Array.from({ length: 1 + (n % 4) }, () => phrase).join(", and ")} end-MED${id}`,
        });
    }
    out.push({ kind: "user", text: "tell me a long story [long]" });
    out.push({
        kind: "assistant",
        text: Array.from({ length: 120 }, (_, i) => `LINE${String(i + 1).padStart(3, "0")} ${PHRASES[(i + 1) % 5]}`).join("\n"),
    });
    return out;
}

const ANCHOR = /^\s*(?:[›●] )?(q\d{3}|MED\d{3}|LINE\d{3})\b/;

function anchorRows(pane: string): Map<string, number> {
    const rows = new Map<string, number>();
    pane.split("\n").forEach((line, row) => {
        const match = ANCHOR.exec(line);
        if (match !== null) rows.set(match[1]!, row);
    });
    return rows;
}

function shifts(before: Map<string, number>, pane: string): Set<number> {
    const out = new Set<number>();
    for (const [key, row] of anchorRows(pane)) {
        const was = before.get(key);
        if (was !== undefined) out.add(was - row);
    }
    return out;
}

// Narrowing after open discards measured entry heights, so the Ctrl+U that
// materializes earlier entries must not move what is already on screen.
test("Ctrl+U moves exactly half a page, including the press that materializes earlier entries", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-test-"));
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "prepend-anchor-session",
                workspace: "/work/vera",
                model: "prepend-anchor-model",
                mode: "review",
                initialUpdates: [{ type: "history", entries: historyEntries(), seq: 0 }],
            }),
            listAgents: async () => [],
        }),
    });
    try {
        await session.waitForVisiblePane("LINE120");
        await session.settle(120);
        session.resize(80, 40);
        await session.settle(150);
        await session.settle(150);
        let settled = anchorRows(session.captureVisiblePane());
        let halfPages = 0;
        for (let press = 1; press <= 60; press += 1) {
            session.sendKey("C-u");
            const frames: string[] = [];
            for (let frame = 0; frame < 3; frame += 1) {
                await session.settle(2);
                frames.push(session.captureVisiblePane());
            }
            await session.settle(40);
            frames.push(session.captureVisiblePane());
            const atTop = anchorRows(frames[3]!).has("q001");
            const first = shifts(settled, frames[0]!);
            for (const shift of first) {
                expect(shift).toBeLessThanOrEqual(0);
                expect(shift).toBeGreaterThanOrEqual(-14);
                if (!atTop) expect(shift).toBe(-14);
            }
            if (!atTop) expect(first.size).toBeGreaterThan(0);
            if (first.has(-14)) halfPages += 1;
            for (let frame = 1; frame < frames.length; frame += 1) {
                const later = shifts(anchorRows(frames[frame - 1]!), frames[frame]!);
                expect([...later].filter((shift) => shift !== 0)).toEqual([]);
            }
            settled = anchorRows(frames[3]!);
        }
        expect(halfPages).toBeGreaterThan(15);
        expect(anchorRows(session.captureVisiblePane()).has("q001")).toBe(true);
    } finally {
        await session.close();
    }
}, 120_000);
