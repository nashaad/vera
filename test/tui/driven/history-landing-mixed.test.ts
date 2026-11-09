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
// Ctrl+U moves by half the transcript viewport, 29 rows at 120x40.
const HALF_PAGE_ROWS = 14;

/** Line counts vary, so the row estimate made before a voyage renders differs from its measured height. */
function voyage(prefix: string, index: number): string {
    const head = `${prefix}${index}`;
    const count = 1 + ((index * 7) % 23);
    return [head, ...Array.from({ length: count - 1 }, (_, line) => `${head} line ${line}`)].join("\n");
}

function caretRows(pane: string): Map<string, number> {
    const rows = new Map<string, number>();
    pane.split("\n").forEach((line, row) => {
        const match = CARET_ROW.exec(line);
        if (match !== null) rows.set(`${match[1]}${match[2]}`, row);
    });
    return rows;
}

function topVoyage(pane: string): [string, number] {
    const first = [...caretRows(pane).entries()].sort((left, right) => left[1] - right[1])[0];
    if (first === undefined) throw new Error(`No voyage caret on screen:\n${pane}`);
    return first;
}

/** Presses Ctrl+U until the first loaded voyage is at the top, so it stays on screen after a half-page step. */
async function pressToLoadedTop(session: Awaited<ReturnType<typeof startTuiTestSession>>, flags: { requested: boolean }): Promise<[string, number]> {
    for (let press = 0; press < 200 && !flags.requested; press += 1) {
        session.sendKey("C-u");
        await session.settle(30);
    }
    expect(flags.requested).toBe(true);
    for (let press = 0; press < 20 && topVoyage(session.captureVisiblePane())[0] !== "TAIL0"; press += 1) {
        session.sendKey("C-u");
        await session.settle(30);
    }
    const [label, row] = topVoyage(session.captureVisiblePane());
    expect(label).toBe("TAIL0");
    return [label, row];
}

async function openHeldLanding(name: string) {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, `tui-${name}-`));
    const tail = Array.from({ length: 40 }, (_, index) => ({
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
        agentId: `${name}-test`,
        workspace: "/work/vera",
        model: `${name}-model`,
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: tail,
            seq: 0,
            page: { pageVersion: 1, hasMore: true, olderBefore: "tail-0", headId: "tail-39", tailId: "tail-39" },
        }],
    });
    const flags = { requested: false };
    const gate: { release?: () => void } = {};
    const client: TuiAgentClient = {
        ...base,
        supportsHostCapability: (capability) => capability === PAGING,
        requestHistoryPage: (before) => {
            flags.requested = true;
            return new Promise<HistoryPageResponse>((resolve) => {
                gate.release = () => resolve({
                    type: "history_page",
                    request_id: `${name}-test`,
                    before,
                    entries: older,
                    page: { pageVersion: 1, hasMore: true, olderBefore: "older-0", headId: "tail-39", tailId: "tail-39" },
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
    return { session, flags, gate };
}

async function sampleRow(
    session: Awaited<ReturnType<typeof startTuiTestSession>>,
    label: string,
    samples: number,
): Promise<number[]> {
    const rows: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        await session.settle(25);
        rows.push(caretRows(session.captureVisiblePane()).get(label) ?? Number.NaN);
    }
    return rows;
}

test("a landing with mixed voyage heights leaves the top voyage on its row", async () => {
    const { session, flags, gate } = await openHeldLanding("mixed-landing");
    try {
        await session.waitForVisiblePane("TAIL39");
        await session.settle(60);
        const [label, row] = await pressToLoadedTop(session, flags);

        gate.release?.();
        const rows = await sampleRow(session, label, 24);
        expect(rows).toEqual(rows.map(() => row));
    } finally {
        gate.release?.();
        await session.close();
    }
}, 180_000);

test("a Ctrl+U sent as a mixed-height page lands moves the view one half page and holds it", async () => {
    const { session, flags, gate } = await openHeldLanding("mixed-key");
    try {
        await session.waitForVisiblePane("TAIL39");
        await session.settle(60);
        const [label, row] = await pressToLoadedTop(session, flags);

        gate.release?.();
        await Bun.sleep(0);
        session.sendKey("C-u");
        const rows = await sampleRow(session, label, 24);
        expect(rows).toEqual(rows.map(() => row + HALF_PAGE_ROWS));
    } finally {
        gate.release?.();
        await session.close();
    }
}, 180_000);

const WALK_CARET = /› P(\d+)(?!\d)/;
const WALK_LINE = /P\d+ line \d+(?!\d)/;

function topWalkIndex(pane: string): number | undefined {
    for (const line of pane.split("\n")) {
        const match = WALK_CARET.exec(line);
        if (match !== null) return Number(match[1]);
    }
    return undefined;
}

/** A body line in the top half-page, so the step moves it and it stays on screen. */
function referenceLine(pane: string): { text: string; row: number } {
    const lines = pane.split("\n");
    for (let row = 0; row <= HALF_PAGE_ROWS && row < lines.length; row += 1) {
        const match = WALK_LINE.exec(lines[row] ?? "");
        if (match !== null) return { text: match[0], row };
    }
    throw new Error(`No body line in the top ${HALF_PAGE_ROWS} rows:\n${pane}`);
}

/** Renders several frames over the window, as the live loop does between key presses. */
async function settleFrames(session: Awaited<ReturnType<typeof startTuiTestSession>>, ms: number): Promise<void> {
    const stepMs = 8;
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
        await session.settle(stepMs);
    }
}

function lineRow(pane: string, text: string): number | undefined {
    const pattern = new RegExp(`${text}(?!\\d)`);
    const row = pane.split("\n").findIndex((line) => pattern.test(line));
    return row === -1 ? undefined : row;
}

test("a walk across mixed-height page landings moves the view one half page on every press", async () => {
    const devRoot = join(tmpdir(), "vera-dev");
    mkdirSync(devRoot, { recursive: true });
    const home = mkdtempSync(join(devRoot, "tui-mixed-walk-"));
    const total = 200;
    const tailStart = 160;
    const pageSize = 30;
    // Every fifth voyage is followed by a completed read, which folds under its header.
    const voyages = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => {
        const index = from + offset;
        const user = { kind: "user" as const, text: voyage("P", index), id: `P${index}` };
        if (index % 5 !== 2) return [user];
        return [
            user,
            { kind: "tool" as const, tool: "read", args: { path: `/work/file-${index}.ts` }, id: `C${index}` },
            { kind: "tool_result" as const, tool: "read", output: `file ${index}\nalpha\nbeta`, isError: false, id: `R${index}` },
        ];
    }).flat();
    const base = createSettingsAnsweringClient({
        agentId: "mixed-walk-test",
        workspace: "/work/vera",
        model: "mixed-walk-model",
        mode: "review",
        initialUpdates: [{
            type: "history",
            entries: voyages(tailStart, total),
            seq: 0,
            page: { pageVersion: 1, hasMore: true, olderBefore: `P${tailStart}`, headId: `P${total - 1}`, tailId: `P${total - 1}` },
        }],
    });
    const client: TuiAgentClient = {
        ...base,
        supportsHostCapability: (capability) => capability === PAGING,
        requestHistoryPage: async (before): Promise<HistoryPageResponse> => {
            // A short host round trip, so a page lands between presses.
            await Bun.sleep(40);
            const end = Number(before.slice(1));
            const start = Math.max(0, end - pageSize);
            return {
                type: "history_page",
                request_id: "mixed-walk-test",
                before,
                entries: voyages(start, end),
                page: {
                    pageVersion: 1,
                    hasMore: start > 0,
                    ...(start > 0 ? { olderBefore: `P${start}` } : {}),
                    headId: `P${total - 1}`,
                    tailId: `P${total - 1}`,
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
        await session.waitForVisiblePane(`P${total - 1}`);
        await session.settle(60);
        const steps: { press: number; step: number }[] = [];
        const late: { press: number; mid: number; after: number }[] = [];
        const lost: number[] = [];
        for (let press = 0; press < 400; press += 1) {
            const before = session.captureVisiblePane();
            if (topWalkIndex(before) === 0) break;
            const reference = referenceLine(before);
            session.sendKey("C-u");
            await settleFrames(session, 40);
            const mid = lineRow(session.captureVisiblePane(), reference.text);
            await settleFrames(session, 160);
            const afterPane = session.captureVisiblePane();
            const after = lineRow(afterPane, reference.text);
            if (mid === undefined || after === undefined) {
                lost.push(press);
                continue;
            }
            // The press that reaches the first voyage can be clamped by the top of the content.
            if (topWalkIndex(afterPane) === 0) continue;
            steps.push({ press, step: after - reference.row });
            if (mid !== after) late.push({ press, mid, after });
        }
        expect(topWalkIndex(session.captureVisiblePane())).toBe(0);
        expect(lost).toEqual([]);
        expect(late).toEqual([]);
        expect(steps.filter((entry) => entry.step !== HALF_PAGE_ROWS)).toEqual([]);
    } finally {
        await session.close();
    }
}, 600_000);
