import {
    FOOTER_LOCKED_SHOWN,
    FOOTER_SLOTS_PER_ROW,
    footerItemShown,
    footerRowCount,
    type FooterItemId,
    type FooterLayout,
} from "./footer-layout.ts";
import type { TuiStatusChunk } from "./status.ts";

export interface FooterItemContent {
    // Longest first. No forms means the item has nothing to show right now.
    readonly forms: readonly (readonly TuiStatusChunk[])[];
    // Held even while the item is narrower or empty, so its neighbours do not
    // shift when a turn starts or ends. Given up before any item is dropped.
    readonly reserve?: number;
}

export type FooterItemContents = Partial<Record<FooterItemId, FooterItemContent>>;

export type FooterItemFate =
    | "shown"
    | "shortened"
    | "cut"
    | "no room"
    | "hidden"
    | "empty";

// The columns an item's cell takes on its row, held space included.
export interface FooterItemSpan {
    readonly row: number;
    readonly start: number;
    readonly end: number;
}

export interface FooterFit {
    readonly rows: readonly (readonly TuiStatusChunk[])[];
    readonly fates: ReadonlyMap<FooterItemId, FooterItemFate>;
    readonly spans: ReadonlyMap<FooterItemId, FooterItemSpan>;
}

interface Cell {
    readonly item: FooterItemId;
    readonly slot: number;
    readonly column: number;
    readonly content: FooterItemContent;
    level: number;
    dropped: boolean;
    cutTo: number | undefined;
}

// The least space kept between two cells on a row.
export const FOOTER_CELL_GAP = 3;

export function fitFooter(
    layout: FooterLayout,
    contents: FooterItemContents,
    working: boolean,
    width: number,
): FooterFit {
    const columns = Math.max(1, width);
    const fates = new Map<FooterItemId, FooterItemFate>();
    const spans = new Map<FooterItemId, FooterItemSpan>();
    const rows: TuiStatusChunk[][] = [];
    const rowCount = footerRowCount(layout);
    layout.slots.forEach((item, slot) => {
        if (item !== null && slot >= rowCount * FOOTER_SLOTS_PER_ROW) fates.set(item, "hidden");
    });
    for (let row = 1; row <= rowCount; row += 1) {
        const cells: Cell[] = [];
        for (let column = 0; column < FOOTER_SLOTS_PER_ROW; column += 1) {
            const slot = (row - 1) * FOOTER_SLOTS_PER_ROW + column;
            const item = layout.slots[slot] ?? null;
            if (item === null) continue;
            if (!footerItemShown(layout, item)) {
                fates.set(item, "hidden");
                continue;
            }
            const content = contents[item];
            if (content === undefined || (content.forms.length === 0 && (content.reserve ?? 0) === 0)) {
                fates.set(item, "empty");
                continue;
            }
            cells.push({ item, slot, column, content, level: 0, dropped: false, cutTo: undefined });
        }
        // Hold space only while shortening is enough; never drop an item for it.
        const hold = squeezeRow(cells, columns, true);
        if (!hold) {
            for (const cell of cells) cell.level = 0;
            squeezeRow(cells, columns, false);
        }
        for (const cell of cells) {
            if (cell.dropped) fates.set(cell.item, "no room");
            else if (cell.content.forms.length === 0) fates.set(cell.item, "empty");
            else if (cell.cutTo !== undefined) fates.set(cell.item, "cut");
            else fates.set(cell.item, cell.level > 0 ? "shortened" : "shown");
        }
        rows.push(drawRow(cells, columns, row, hold, spans));
    }
    return { rows, fates, spans };
}

// Shorten the highest-numbered slot that still can, then drop the highest
// slot (never the key hints), and only cut text with an ellipsis when one
// item is left. With hold, stops before dropping and reports whether it fits.
function squeezeRow(cells: readonly Cell[], columns: number, hold: boolean): boolean {
    const highestFirst = cells.toSorted((left, right) => right.slot - left.slot);
    while (rowColumns(cells, hold) > columns) {
        const shorten = highestFirst.find((cell) => !cell.dropped && cell.level < cell.content.forms.length - 1);
        if (shorten !== undefined) {
            shorten.level += 1;
            continue;
        }
        if (hold) return false;
        const standing = highestFirst.filter((cell) => !cell.dropped && cellColumns(cell, hold) > 0);
        const drop = standing.find((cell) => !FOOTER_LOCKED_SHOWN.has(cell.item));
        if (standing.length > 1 && drop !== undefined) {
            drop.dropped = true;
            continue;
        }
        const last = standing[0];
        if (last !== undefined) last.cutTo = columns;
        return true;
    }
    return true;
}

function standingCells(cells: readonly Cell[], hold: boolean): Cell[] {
    return cells.filter((cell) => !cell.dropped && cellColumns(cell, hold) > 0);
}

function rowColumns(cells: readonly Cell[], hold: boolean): number {
    const standing = standingCells(cells, hold);
    const widths = standing.reduce((total, cell) => total + cellColumns(cell, hold), 0);
    return widths + FOOTER_CELL_GAP * Math.max(0, standing.length - 1);
}

function cellText(cell: Cell): readonly TuiStatusChunk[] {
    const form = cell.content.forms[cell.level] ?? [];
    return cell.cutTo === undefined ? form : cutChunks(form, cell.cutTo);
}

function cellColumns(cell: Cell, hold: boolean): number {
    const drawn = chunksWidth(cellText(cell));
    return hold ? Math.max(drawn, cell.content.reserve ?? 0) : drawn;
}

// Two or more cells spread from edge to edge with even gaps. A lone cell keeps
// to the side its slot is on: slots 1 and 2 left, 3 and 4 right.
function drawRow(
    cells: readonly Cell[],
    columns: number,
    row: number,
    hold: boolean,
    spans: Map<FooterItemId, FooterItemSpan>,
): TuiStatusChunk[] {
    const standing = standingCells(cells, hold);
    const widths = standing.map((cell) => cellColumns(cell, hold));
    const total = widths.reduce((sum, width) => sum + width, 0);
    const gaps = standing.length - 1;
    const free = Math.max(0, columns - total);
    const out: TuiStatusChunk[] = [];
    let start = standing.length === 1 && standing[0]!.column >= FOOTER_SLOTS_PER_ROW / 2 ? free : 0;
    let column = 0;
    standing.forEach((cell, index) => {
        if (index > 0) start += Math.floor(free / gaps) + (index <= free % gaps ? 1 : 0);
        const width = widths[index]!;
        const text = cellText(cell);
        // Inside held space, text keeps to the side of the row its slot is on.
        const inset = cell.column >= FOOTER_SLOTS_PER_ROW / 2 ? width - chunksWidth(text) : 0;
        const textStart = start + inset;
        if (textStart > column) out.push({ text: " ".repeat(textStart - column), tone: "muted" });
        out.push(...text);
        column = textStart + chunksWidth(text);
        spans.set(cell.item, { row, start, end: start + width });
        start += width;
    });
    return out;
}

export function chunksWidth(chunks: readonly TuiStatusChunk[]): number {
    return chunks.reduce((total, chunk) => total + Bun.stringWidth(chunk.text), 0);
}

function cutChunks(chunks: readonly TuiStatusChunk[], columns: number): TuiStatusChunk[] {
    if (chunksWidth(chunks) <= columns) return [...chunks];
    const out: TuiStatusChunk[] = [];
    let room = Math.max(0, columns - 1);
    for (const chunk of chunks) {
        if (room <= 0) break;
        let text = "";
        for (const character of chunk.text) {
            const next = Bun.stringWidth(character);
            if (next > room) {
                room = 0;
                break;
            }
            text += character;
            room -= next;
        }
        if (text.length > 0) out.push({ ...chunk, text });
    }
    const tone = out.at(-1)?.tone ?? chunks[0]?.tone ?? "muted";
    out.push({ text: "…", tone });
    return out;
}
