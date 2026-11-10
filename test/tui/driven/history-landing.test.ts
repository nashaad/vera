import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import type { HistoryPageResponse } from "../../../src/host/protocol.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const PAGING = "agent.history-paging.v1";
const CARET_ROW = /› (TAIL|OLDER)(\d+)(?!\d)/;
const WALK_CARET = /› V(\d+)(?!\d)/;
// voyage() gives eight text lines, which the screen draws in eleven rows (band gap and row padding).
const VOYAGE_ROWS = 11;

function voyage(prefix: string, index: number): string {
    const head = `${prefix}${index}`;
    return [head, ...Array.from({ length: 7 }, (_, line) => `${head} line ${line}`)].join("\n");
}

function caretRows(pane: string): Map<string, number> {
    const rows = new Map<string, number>();
    pane.split("\n").forEach((line, row) => {
        const match = CARET_ROW.exec(line);
        if (match !== null) rows.set(`${match[1]}${match[2]}`, row);
    });
    return rows;
}

/** Scroll position in rows, from the caret voyage's index and its screen row. A Ctrl+U press lowers it by the step. */
function walkPosition(pane: string): { index: number; position: number } | undefined {
    const lines = pane.split("\n");
    for (let row = 0; row < lines.length; row += 1) {
        const match = WALK_CARET.exec(lines[row] ?? "");
        if (match !== null) {
            const index = Number(match[1]);
            return { index, position: VOYAGE_ROWS * index - row };
        }
    }
    return undefined;
}

test("a landing page leaves the entry at the top of the screen on its row", async () => {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-landing-"));
    const tail = Array.from({ length: 60 }, (_, index) => ({
        kind: "user" as const,
        text: voyage("TAIL", index),
        id: `tail-${index}`,
    }));
    const older = Array.from({ length: 100 }, (_, index) => ({
        kind: "user" as const,
        text: voyage("OLDER", index),
        id: `older-${index}`,
    }));
    const base = createSettingsAnsweringClient({
        agentId: "landing-test",
        workspace: "/work/vera",
        model: "landing-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: tail,
            seq: 0,
            page: { pageVersion: 1, hasMore: true, olderBefore: "tail-0", headId: "tail-59", tailId: "tail-59" },
        }],
    });
    let requested = false;
    let release: (() => void) | undefined;
    const client: TuiAgentClient = {
        ...base,
        supportsHostCapability: (capability) => capability === PAGING,
        requestHistoryPage: (before) => {
            requested = true;
            return new Promise<HistoryPageResponse>((resolve) => {
                release = () => resolve({
                    type: "history_page",
                    request_id: "landing-test",
                    before,
                    entries: older,
                    page: { pageVersion: 1, hasMore: true, olderBefore: "older-0", headId: "tail-59", tailId: "tail-59" },
                });
            });
        },
    };
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    try {
        await session.waitForVisiblePane("TAIL59");
        await session.settle(60);
        for (let press = 0; press < 80 && !requested; press += 1) {
            session.sendKey("C-u");
            await session.settle(30);
        }
        expect(requested).toBe(true);
        const before = [...caretRows(session.captureVisiblePane()).entries()]
            .sort((left, right) => left[1] - right[1])[0];
        expect(before).toBeDefined();
        const [label, row] = before ?? ["", -1];

        release?.();
        // Every frame after the landing is sampled, so a move that a later frame reverses still shows in drift.
        const landed: number[] = [];
        for (let sample = 0; sample < 24; sample += 1) {
            await session.settle(25);
            landed.push(caretRows(session.captureVisiblePane()).get(label) ?? Number.NaN);
        }
        const drift = landed.map((landedRow) => Math.abs(landedRow - row));
        expect(Math.max(...drift)).toBeLessThanOrEqual(1);

        let reachedOlder = false;
        for (let press = 0; press < 60 && !reachedOlder; press += 1) {
            session.sendKey("C-u");
            await session.settle(30);
            reachedOlder = [...caretRows(session.captureVisiblePane()).keys()]
                .some((key) => key.startsWith("OLDER"));
        }
        expect(reachedOlder).toBe(true);
    } finally {
        release?.();
        await session.close();
    }
}, 120_000);

test("a walk across page landings moves the view up on every press and holds it between presses", async () => {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-walk-"));
    const voyages = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => {
        const index = from + offset;
        return { kind: "user" as const, text: voyage("V", index), id: `V${index}` };
    });
    const base = createSettingsAnsweringClient({
        agentId: "walk-test",
        workspace: "/work/vera",
        model: "walk-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: voyages(140, 200),
            seq: 0,
            page: { pageVersion: 1, hasMore: true, olderBefore: "V140", headId: "V199", tailId: "V199" },
        }],
    });
    const client: TuiAgentClient = {
        ...base,
        supportsHostCapability: (capability) => capability === PAGING,
        requestHistoryPage: async (before): Promise<HistoryPageResponse> => {
            // A short host round trip, so a page lands between presses.
            await new Promise((resolve) => setTimeout(resolve, 40));
            const end = Number(before.slice(1));
            const start = Math.max(0, end - 30);
            return {
                type: "history_page",
                request_id: "walk-test",
                before,
                entries: voyages(start, end),
                page: {
                    pageVersion: 1,
                    hasMore: start > 0,
                    ...(start > 0 ? { olderBefore: `V${start}` } : {}),
                    headId: "V199",
                    tailId: "V199",
                },
            };
        },
    };
    const session = await startTuiTestSession({
        home,
        width: 120,
        height: 40,
        dependencies: () => ({ client, listAgents: async () => [] }),
    });
    try {
        await session.waitForVisiblePane("V199");
        await session.settle(60);
        const settled: { index: number; position: number }[] = [];
        const late: { press: number; from: number; to: number }[] = [];
        for (let press = 0; press < 260; press += 1) {
            session.sendKey("C-u");
            await session.settle(40);
            const first = walkPosition(session.captureVisiblePane());
            await session.settle(160);
            const second = walkPosition(session.captureVisiblePane());
            if (first === undefined || second === undefined) continue;
            if (first.position !== second.position) {
                late.push({ press, from: first.position, to: second.position });
            }
            settled.push(second);
            if (second.index === 0) break;
        }
        const previous = (at: number) => settled[at - 1]?.position ?? Number.NEGATIVE_INFINITY;
        const rises = settled.flatMap((sample, at) =>
            sample.position > previous(at) && at > 0 ? [{ at, index: sample.index }] : []
        );
        const stalls = settled.flatMap((sample, at) =>
            at > 0 && sample.position === previous(at) ? [{ at, index: sample.index }] : []
        );
        expect(settled.at(-1)?.index).toBe(0);
        expect(late).toEqual([]);
        expect(rises).toEqual([]);
        expect(stalls).toEqual([]);
    } finally {
        await session.close();
    }
}, 120_000);
