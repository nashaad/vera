import {
    DEFAULT_FOOTER_LAYOUT,
    FOOTER_ITEM_IDS,
    FOOTER_LOCKED_SHOWN,
    FOOTER_ROWS,
    FOOTER_SLOT_COUNT,
    FOOTER_SLOTS_PER_ROW,
    isFooterItemId,
    type FooterItemId,
    type FooterLayout,
} from "./footer-layout.ts";

// The footer_layout key in tui.json. rows[0] is the first row under the
// composer; null is an empty slot.
export interface DiskFooterLayout {
    readonly rows: readonly (readonly (FooterItemId | null)[])[];
    readonly hidden?: readonly FooterItemId[];
}

// Anything unreadable falls back to the default for that part. An item the
// file does not place goes to its default slot, or the first free one.
export function parseFooterLayout(value: unknown): FooterLayout {
    if (!isRecord(value)) return DEFAULT_FOOTER_LAYOUT;
    const slots: (FooterItemId | null)[] = new Array<FooterItemId | null>(FOOTER_SLOT_COUNT).fill(null);
    const rows = Reflect.get(value, "rows");
    (Array.isArray(rows) ? rows.slice(0, FOOTER_ROWS) : []).forEach((row, rowIndex) => {
        (Array.isArray(row) ? row.slice(0, FOOTER_SLOTS_PER_ROW) : []).forEach((entry, column) => {
            if (isFooterItemId(entry) && !slots.includes(entry)) slots[rowIndex * FOOTER_SLOTS_PER_ROW + column] = entry;
        });
    });
    for (const item of FOOTER_ITEM_IDS) {
        if (slots.includes(item)) continue;
        const home = DEFAULT_FOOTER_LAYOUT.slots.indexOf(item);
        slots[slots[home] === null ? home : slots.indexOf(null)] = item;
    }
    return {
        slots,
        hidden: itemList(Reflect.get(value, "hidden")).filter((item) => !FOOTER_LOCKED_SHOWN.has(item)),
    };
}

// Known items, each once, in the order given.
function itemList(value: unknown): FooterItemId[] {
    const out: FooterItemId[] = [];
    for (const entry of Array.isArray(value) ? value : []) {
        if (isFooterItemId(entry) && !out.includes(entry)) out.push(entry);
    }
    return out;
}

export function footerLayoutToDisk(layout: FooterLayout): DiskFooterLayout {
    const rows: (FooterItemId | null)[][] = [];
    for (let row = 0; row < FOOTER_ROWS; row += 1) {
        const start = row * FOOTER_SLOTS_PER_ROW;
        rows.push(Array.from({ length: FOOTER_SLOTS_PER_ROW }, (_unused, column) => layout.slots[start + column] ?? null));
    }
    const hidden = FOOTER_ITEM_IDS.filter((item) => layout.hidden.includes(item));
    return hidden.length === 0 ? { rows } : { rows, hidden };
}

export function isDefaultFooterLayout(layout: FooterLayout): boolean {
    return JSON.stringify(footerLayoutToDisk(layout)) === JSON.stringify(footerLayoutToDisk(DEFAULT_FOOTER_LAYOUT));
}

function isRecord(value: unknown): value is object {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
