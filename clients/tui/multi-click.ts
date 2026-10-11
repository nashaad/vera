import {
    type CliRenderer,
    Renderable,
    type Selection,
    TextBufferRenderable,
} from "@opentui/core";

import type { SelectionPoint } from "./selection.ts";

const MULTI_CLICK_MS = 500;
const WORD_CHARACTER = /[\p{L}\p{N}_\-./~]/u;

export type ClickExpansion = "word" | "line";

export interface ClickCounter {
    register(point: SelectionPoint, now: number): number;
    reset(): void;
}

export function createClickCounter(): ClickCounter {
    let last: { point: SelectionPoint; at: number; count: number } | undefined;
    return {
        register(point, now) {
            const continues = last !== undefined
                && last.count < 3
                && now - last.at <= MULTI_CLICK_MS
                && point.y === last.point.y
                && Math.abs(point.x - last.point.x) <= 1;
            const count = continues && last !== undefined ? last.count + 1 : 1;
            last = { point, at: now, count };
            return count;
        },
        reset() {
            last = undefined;
        },
    };
}

export interface ClickRange {
    readonly anchor: SelectionPoint;
    readonly focus: SelectionPoint;
}

interface TextGeometry {
    readonly x: number;
    readonly y: number;
    readonly scrollY: number;
    readonly plainText: string;
    readonly lineInfo: {
        readonly lineStartCols: readonly number[];
        readonly lineWidthCols: readonly number[];
        readonly lineSources: readonly number[];
    };
}

// Screen range covering the word or wrapped source line under `point`; focus x is exclusive.
export function clickRange(
    text: TextGeometry,
    point: SelectionPoint,
    expansion: ClickExpansion,
): ClickRange | undefined {
    const { lineStartCols, lineWidthCols, lineSources } = text.lineInfo;
    const row = point.y - text.y + text.scrollY;
    const source = lineSources[row];
    if (source === undefined) {
        return undefined;
    }
    const rows: number[] = [];
    lineSources.forEach((candidate, index) => {
        if (candidate === source) rows.push(index);
    });
    const firstRow = rows[0] ?? row;
    const lastRow = rows[rows.length - 1] ?? row;
    const base = lineStartCols[firstRow] ?? 0;
    const toScreen = (column: number, endExclusive: boolean): SelectionPoint => {
        const probe = endExclusive ? column - 1 : column;
        const onRow = rows.find((candidate) => {
            const start = (lineStartCols[candidate] ?? 0) - base;
            return probe >= start && probe < start + (lineWidthCols[candidate] ?? 0);
        }) ?? lastRow;
        const start = (lineStartCols[onRow] ?? 0) - base;
        return { x: text.x + column - start, y: text.y + onRow - text.scrollY };
    };

    if (expansion === "line") {
        return {
            anchor: { x: text.x, y: text.y + firstRow - text.scrollY },
            focus: {
                x: text.x + (lineWidthCols[lastRow] ?? 0),
                y: text.y + lastRow - text.scrollY,
            },
        };
    }

    const clicked = (lineStartCols[row] ?? 0) - base + point.x - text.x;
    const cells = sourceCells(text.plainText.split("\n")[source] ?? "");
    const at = cells.findIndex((cell) => clicked >= cell.start && clicked < cell.end);
    if (at === -1 || !WORD_CHARACTER.test(cells[at]?.text ?? "")) {
        return undefined;
    }
    let from = at;
    let to = at;
    while (from > 0 && WORD_CHARACTER.test(cells[from - 1]?.text ?? "")) from--;
    while (to < cells.length - 1 && WORD_CHARACTER.test(cells[to + 1]?.text ?? "")) to++;
    while (to > from && cells[to]?.text === ".") to--;
    const startCol = cells[from]?.start ?? 0;
    const endCol = cells[to]?.end ?? startCol;
    return { anchor: toScreen(startCol, false), focus: toScreen(endCol, true) };
}

interface Cell {
    readonly text: string;
    readonly start: number;
    readonly end: number;
}

function sourceCells(line: string): Cell[] {
    const cells: Cell[] = [];
    let column = 0;
    for (const { segment } of new Intl.Segmenter().segment(line)) {
        const width = Bun.stringWidth(segment);
        cells.push({ text: segment, start: column, end: column + width });
        column += width;
    }
    return cells;
}

// A plain click arrives as an empty selection; the second and third widen it in place.
export function expandClick(
    renderer: CliRenderer,
    selection: Selection,
    counter: ClickCounter,
    now: number,
): Selection | undefined {
    const { anchor, focus } = selection;
    if (anchor.x !== focus.x || anchor.y !== focus.y) {
        counter.reset();
        return undefined;
    }
    const count = counter.register(anchor, now);
    if (count < 2) {
        return undefined;
    }
    const target = Renderable.renderablesByNumber.get(renderer.hitTest(anchor.x, anchor.y));
    if (!(target instanceof TextBufferRenderable) || !target.selectable) {
        return undefined;
    }
    const range = clickRange(target, anchor, count === 2 ? "word" : "line");
    if (range === undefined) {
        return undefined;
    }
    renderer.startSelection(target, range.anchor.x, range.anchor.y);
    renderer.updateSelection(target, range.focus.x, range.focus.y, { finishDragging: true });
    return renderer.getSelection() ?? undefined;
}
