// Which footer item sits in which numbered slot below the composer.
// Client-agnostic: a GUI can read the same slots without footer-fit.ts.

export type FooterItemId =
    | "status"
    | "keys"
    | "limits"
    | "place"
    | "activity"
    | "panes";

export interface FooterLayout {
    // Slot 1 is index 0, read left to right then down. A higher slot number
    // gives way first when a row runs out of room.
    readonly slots: readonly (FooterItemId | null)[];
    readonly hidden: readonly FooterItemId[];
}

// The footer's width at an 80-column terminal. The layout screen draws at this
// width and refuses an edit that would leave an item out at it.
export const FOOTER_STANDARD_COLUMNS = 72;
export const FOOTER_STANDARD_TERMINAL = 80;
export const FOOTER_ROWS = 3;
export const FOOTER_SLOTS_PER_ROW = 4;
export const FOOTER_SLOT_COUNT = FOOTER_ROWS * FOOTER_SLOTS_PER_ROW;

export const FOOTER_ITEM_IDS: readonly FooterItemId[] = [
    "status",
    "keys",
    "limits",
    "place",
    "activity",
    "panes",
];

export const FOOTER_ITEM_LABELS: Readonly<Record<FooterItemId, string>> = {
    status: "live status",
    keys: "key hints",
    limits: "limits",
    place: "folder, branch",
    activity: "activity strip",
    panes: "pane controls",
};

// The key hints are the visible way to the keys card.
export const FOOTER_LOCKED_SHOWN: ReadonlySet<FooterItemId> = new Set(["keys"]);

export const DEFAULT_FOOTER_LAYOUT: FooterLayout = {
    slots: [
        "status", "limits", null, "keys",
        "place", null, "panes", "activity",
        null, null, null, null,
    ],
    hidden: [],
};

export function isFooterItemId(value: unknown): value is FooterItemId {
    return typeof value === "string" && (FOOTER_ITEM_IDS as readonly string[]).includes(value);
}

export function footerItemShown(layout: FooterLayout, item: FooterItemId): boolean {
    return FOOTER_LOCKED_SHOWN.has(item) || !layout.hidden.includes(item);
}

// Index into layout.slots, or -1 when the item has no slot.
export function footerItemSlot(layout: FooterLayout, item: FooterItemId): number {
    return layout.slots.indexOf(item);
}

// Row 1 is the first row under the composer.
export function footerSlotRow(slot: number): number {
    return Math.floor(slot / FOOTER_SLOTS_PER_ROW) + 1;
}

// The last row holding a shown item; hidden items do not keep a row open.
export function footerRowCount(layout: FooterLayout): number {
    let rows = 1;
    layout.slots.forEach((item, slot) => {
        if (item !== null && footerItemShown(layout, item)) rows = Math.max(rows, footerSlotRow(slot));
    });
    return rows;
}
