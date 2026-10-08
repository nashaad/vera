import { bold, fg, type TextChunk } from "@opentui/core";

import type { ChecklistPresentation } from "../../src/model/types.ts";
import { TUI_MUTED, TUI_SUCCESS, TUI_TEXT } from "./palette.ts";

/** The checklist row's model, with no OpenTUI in it. It decides which items show and how each reads. */
export type TuiChecklistLine =
    | {
        readonly kind: "title";
        readonly title: string;
        readonly done: number;
        readonly total: number;
    }
    | { readonly kind: "item"; readonly text: string; readonly state: TuiChecklistItemState }
    | { readonly kind: "folded_done"; readonly count: number }
    | { readonly kind: "more_open"; readonly count: number };

export type TuiChecklistItemState = "done" | "just_done" | "next" | "open";

const FULL_LIST_LIMIT = 8;
const FOLDED_RECENT_DONE = 2;
const FOLDED_OPEN = 3;
const DEFAULT_TITLE = "Todo";

export function tuiChecklistLines(
    checklist: ChecklistPresentation,
): TuiChecklistLine[] {
    const items = checklist.items;
    const done = items.filter((item) => item.done).length;
    const nextIndex = items.findIndex((item) => !item.done);
    const title: TuiChecklistLine = {
        kind: "title",
        title: checklist.title ?? DEFAULT_TITLE,
        done,
        total: items.length,
    };
    const itemLine = (index: number): TuiChecklistLine => {
        const item = items[index]!;
        const state: TuiChecklistItemState = item.justDone === true
            ? "just_done"
            : item.done
            ? "done"
            : index === nextIndex
            ? "next"
            : "open";
        return { kind: "item", text: plainItemText(item.text), state };
    };
    if (items.length <= FULL_LIST_LIMIT) {
        return [title, ...items.map((_, index) => itemLine(index))];
    }

    const doneIndexes = items.flatMap((item, index) => item.done ? [index] : []);
    const recentDone = new Set(doneIndexes.slice(-FOLDED_RECENT_DONE));
    const shownDone = doneIndexes.filter((index) =>
        recentDone.has(index) || items[index]!.justDone === true
    );
    const openIndexes = items.flatMap((item, index) => item.done ? [] : [index]);
    const shownOpen = openIndexes.slice(0, FOLDED_OPEN);
    const shown = [...shownDone, ...shownOpen].sort((left, right) => left - right);

    const lines: TuiChecklistLine[] = [title];
    const foldedDone = doneIndexes.length - shownDone.length;
    if (foldedDone > 0) lines.push({ kind: "folded_done", count: foldedDone });
    lines.push(...shown.map(itemLine));
    const moreOpen = openIndexes.length - shownOpen.length;
    if (moreOpen > 0) lines.push({ kind: "more_open", count: moreOpen });
    return lines;
}

export function tuiChecklistText(checklist: ChecklistPresentation): string {
    return tuiChecklistLines(checklist).map(lineText).join("\n");
}

export function renderTuiChecklist(
    checklist: ChecklistPresentation,
): TextChunk[] {
    return tuiChecklistLines(checklist).flatMap((line, index) => {
        const chunks = lineChunks(line);
        return index === 0 ? chunks : [fg(TUI_MUTED)("\n"), ...chunks];
    });
}

function lineText(line: TuiChecklistLine): string {
    if (line.kind === "title") return `${line.title}  ${line.done}/${line.total}`;
    if (line.kind === "folded_done") return `✓ ${line.count} done`;
    if (line.kind === "more_open") return `○ ${line.count} more`;
    return `${itemMarker(line.state)} ${line.text}`;
}

function lineChunks(line: TuiChecklistLine): TextChunk[] {
    if (line.kind === "title") {
        return [
            bold(fg(TUI_TEXT)(line.title)),
            fg(TUI_MUTED)(`  ${line.done}/${line.total}`),
        ];
    }
    if (line.kind === "folded_done" || line.kind === "more_open") {
        return [fg(TUI_MUTED)(lineText(line))];
    }
    const color = line.state === "just_done"
        ? TUI_SUCCESS
        : line.state === "next"
        ? TUI_TEXT
        : TUI_MUTED;
    return [fg(color)(`${itemMarker(line.state)} ${line.text}`)];
}

function itemMarker(state: TuiChecklistItemState): string {
    return state === "done" || state === "just_done" ? "✓" : "○";
}

// Items are markdown source; strike-through only repeats the checkbox.
function plainItemText(text: string): string {
    return text.replace(/~~|\*\*|`/g, "").trim();
}
