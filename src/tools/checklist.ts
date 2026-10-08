import type { ChecklistItem } from "../model/types.ts";

const MAX_CHECKLIST_ITEMS = 200;
const MAX_ITEM_CHARS = 500;

const TASK_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/;

export interface ParsedChecklist {
    readonly title?: string;
    readonly items: readonly ChecklistItem[];
}

/** Reads markdown task-list items (`- [ ] ...`, `- [x] ...`) and the first heading. */
export function parseChecklist(markdown: string): ParsedChecklist | undefined {
    let title: string | undefined;
    const items: ChecklistItem[] = [];
    for (const line of markdown.split("\n")) {
        const task = TASK_ITEM.exec(line);
        if (task !== null) {
            const text = task[2]!;
            if (text.length > MAX_ITEM_CHARS) return undefined;
            items.push({ text, done: task[1] !== " " });
            continue;
        }
        if (title === undefined) {
            const heading = HEADING.exec(line);
            if (heading !== null) title = heading[1]!;
        }
    }
    if (items.length === 0 || items.length > MAX_CHECKLIST_ITEMS) {
        return undefined;
    }
    return title === undefined ? { items } : { title, items };
}

/** Marks items that are done now but were not a done item before the write. */
export function markJustDone(
    before: readonly ChecklistItem[],
    after: readonly ChecklistItem[],
): ChecklistItem[] {
    const doneBefore = new Set(
        before.filter((item) => item.done).map((item) => itemKey(item.text)),
    );
    return after.map((item) =>
        item.done && !doneBefore.has(itemKey(item.text))
            ? { ...item, justDone: true }
            : item
    );
}

function itemKey(text: string): string {
    return text.replace(/~~/g, "").trim();
}
