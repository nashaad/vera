import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const LABEL = /TAIL(\d+)/;
const PRESSES = 20;

// Ordinal of each TAIL label on the given pane, keyed to its screen row.
function labelRows(pane: string): Map<number, number> {
    const rows = new Map<number, number>();
    pane.split("\n").forEach((line, row) => {
        const match = LABEL.exec(line);
        if (match !== null) rows.set(Number(match[1]), row);
    });
    return rows;
}

test("each Ctrl+U press moves 14 rows at 120x40 and no entry is skipped", async () => {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-walk-up-steps-"));
    const client = createSettingsAnsweringClient({
        agentId: "walk-up-steps-test",
        workspace: "/work/vera",
        model: "walk-up-steps-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: Array.from({ length: 200 }, (_, index) => ({
                kind: "user" as const,
                text: `TAIL${index}`,
                id: `tail-${index}`,
            })),
            seq: 0,
            page: {
                pageVersion: 1,
                hasMore: false,
                olderBefore: "tail-0",
                headId: "tail-199",
                tailId: "tail-199",
            },
        }],
    });
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    try {
        await session.waitForVisiblePane("TAIL199");
        await session.settle(60);
        const seen = new Set<number>();
        const steps: number[] = [];
        for (let press = 0; press < PRESSES; press += 1) {
            const beforeRows = labelRows(session.captureVisiblePane());
            for (const ordinal of beforeRows.keys()) seen.add(ordinal);
            const first = [...beforeRows.entries()].sort((a, b) => a[1] - b[1])[0];
            if (first === undefined) throw new Error("no TAIL label on screen before the press");
            const [anchor, anchorRow] = first;
            session.sendKey("C-u");
            await session.settle(0);
            const afterRows = labelRows(session.captureVisiblePane());
            for (const ordinal of afterRows.keys()) seen.add(ordinal);
            const movedRow = afterRows.get(anchor);
            if (movedRow === undefined) throw new Error(`anchor TAIL${anchor} left the screen`);
            steps.push(movedRow - anchorRow);
        }
        expect(steps).toEqual(Array.from({ length: PRESSES }, () => 14));
        const ordinals = [...seen].sort((a, b) => a - b);
        const lowest = ordinals[0];
        const highest = ordinals[ordinals.length - 1];
        if (lowest === undefined || highest === undefined) throw new Error("no TAIL label was seen");
        expect(ordinals.length).toBe(highest - lowest + 1);
    } finally {
        await session.close();
    }
}, 120_000);
