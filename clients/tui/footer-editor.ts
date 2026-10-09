// The Footer layout screen under /settings: a numbered grid of slots under a
// canvas drawn at the standard width. Pure state and keys; footer-editor-view.ts draws it.

import { fitFooter, type FooterFit } from "./footer-fit.ts";
import {
    DEFAULT_FOOTER_LAYOUT,
    FOOTER_ITEM_IDS,
    FOOTER_ITEM_LABELS,
    FOOTER_LOCKED_SHOWN,
    FOOTER_SLOT_COUNT,
    FOOTER_SLOTS_PER_ROW,
    FOOTER_STANDARD_COLUMNS,
    FOOTER_STANDARD_TERMINAL,
    type FooterItemId,
    type FooterLayout,
} from "./footer-layout.ts";
import type { FooterPreview, FooterSeed } from "./footer-seed.ts";
import { isTuiDialTabKey } from "./keymap.ts";

export type FooterEditorField = "preview" | "slots" | "reset";

export interface FooterEditorState {
    readonly layout: FooterLayout;
    readonly seed: FooterSeed;
    readonly preview: FooterPreview;
    readonly field: FooterEditorField;
    // The grid cursor, an index into layout.slots. Kept while another field has focus.
    readonly slot: number;
    readonly carry?: FooterCarry;
    // Why the last key changed nothing; cleared by the next key.
    readonly refused?: string;
}

// The item being moved, where it came from, and the layout to put back on Escape.
export interface FooterCarry {
    readonly item: FooterItemId;
    readonly from: number;
    readonly before: FooterLayout;
}

export interface FooterEditorKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface FooterEditorTransition {
    // Undefined closes the screen; the caller saves the layout it last saw.
    readonly state?: FooterEditorState;
    readonly handled: boolean;
}

export const FOOTER_REFUSED_FIT = `won't fit at ${FOOTER_STANDARD_TERMINAL} columns`;

const FIELDS: readonly FooterEditorField[] = ["preview", "slots", "reset"];

export function startFooterEditor(layout: FooterLayout, seed: FooterSeed, working: boolean): FooterEditorState {
    return { layout, seed, preview: working ? "working" : "idle", field: "slots", slot: 0 };
}

export function footerEditorFit(state: FooterEditorState): FooterFit {
    return standardFit(state.layout, state.seed, state.preview);
}

// The item under the grid cursor, or the one being carried.
export function footerEditorFocusedItem(state: FooterEditorState): FooterItemId | undefined {
    if (state.carry !== undefined) return state.carry.item;
    if (state.field !== "slots") return undefined;
    return state.layout.slots[state.slot] ?? undefined;
}

export function handleFooterEditorKey(state: FooterEditorState, key: FooterEditorKey): FooterEditorTransition {
    if (key.ctrl || key.meta || key.super || key.hyper) return { state, handled: false };
    const { refused: _refused, ...settled } = state;
    if (settled.carry !== undefined) return carryKey(settled, settled.carry, key);
    if (key.name === "escape") return { handled: true };
    if (isTuiDialTabKey(key)) {
        const step = key.shift === true || key.name === "backtab" ? -1 : 1;
        return moved(settled, { field: FIELDS[wrap(FIELDS.indexOf(settled.field) + step, FIELDS.length)]! });
    }
    if (settled.field === "preview") return previewKey(settled, key);
    if (settled.field === "reset") return resetKey(settled, key);
    return slotKey(settled, key);
}

function previewKey(state: FooterEditorState, key: FooterEditorKey): FooterEditorTransition {
    if (key.name === "down") return moved(state, { field: "slots", slot: state.slot % FOOTER_SLOTS_PER_ROW });
    if (key.name === "up") return moved(state, { field: "reset" });
    if (["left", "right", "space", "return"].includes(key.name)) return moved(state, { preview: otherPreview(state.preview) });
    return { state, handled: true };
}

function resetKey(state: FooterEditorState, key: FooterEditorKey): FooterEditorTransition {
    if (key.name === "up") {
        return moved(state, { field: "slots", slot: FOOTER_SLOT_COUNT - FOOTER_SLOTS_PER_ROW + state.slot % FOOTER_SLOTS_PER_ROW });
    }
    if (key.name === "down") return moved(state, { field: "preview" });
    if (key.name === "return" || key.name === "space") return moved(state, { layout: DEFAULT_FOOTER_LAYOUT });
    return { state, handled: true };
}

function slotKey(state: FooterEditorState, key: FooterEditorKey): FooterEditorTransition {
    const item = state.layout.slots[state.slot] ?? null;
    if (key.name === "up" && state.slot < FOOTER_SLOTS_PER_ROW) return moved(state, { field: "preview" });
    if (key.name === "down" && state.slot >= FOOTER_SLOT_COUNT - FOOTER_SLOTS_PER_ROW) return moved(state, { field: "reset" });
    const target = stepSlot(state.slot, key.name);
    if (target !== undefined) return moved(state, { slot: target });
    if (item === null) return { state, handled: true };
    if (key.name === "return") return pickUp(state, item);
    if (key.name === "space") {
        if (FOOTER_LOCKED_SHOWN.has(item)) return refuse(state, `${FOOTER_ITEM_LABELS[item]} can't be hidden`);
        return gated(state, toggleShown(state.layout, item));
    }
    return { state, handled: true };
}

// Arrows move the item through the grid; whatever sits where it lands moves to
// the slot it came from. Each step starts again from the layout before pickup.
function carryKey(state: FooterEditorState, carry: FooterCarry, key: FooterEditorKey): FooterEditorTransition {
    if (key.name === "escape") return moved(putDown(state), { layout: carry.before, slot: carry.from });
    if (key.name === "return" || key.name === "space") {
        const added = [...misfits(state.layout, state.seed)].some((item) => !misfits(carry.before, state.seed).has(item));
        return added ? refuse(state, FOOTER_REFUSED_FIT) : moved(putDown(state), {});
    }
    const target = stepSlot(state.slot, key.name);
    if (target === undefined) return { state, handled: true };
    return moved(state, { slot: target, layout: placed(carry.before, carry.from, target) });
}

// Picking up an item that has nothing to show in this preview flips to the
// state where it does, so it is on the canvas while it moves.
function pickUp(state: FooterEditorState, item: FooterItemId): FooterEditorTransition {
    const drawn = (preview: FooterPreview): boolean => {
        const fate = standardFit(state.layout, state.seed, preview).fates.get(item);
        return fate === "shown" || fate === "shortened" || fate === "cut";
    };
    const preview = drawn(state.preview) || !drawn(otherPreview(state.preview)) ? state.preview : otherPreview(state.preview);
    return moved(state, { preview, carry: { item, from: state.slot, before: state.layout } });
}

function placed(layout: FooterLayout, from: number, to: number): FooterLayout {
    const slots = [...layout.slots];
    const landing = slots[to] ?? null;
    slots[to] = slots[from] ?? null;
    slots[from] = landing;
    return { ...layout, slots };
}

function stepSlot(slot: number, name: string): number | undefined {
    const column = slot % FOOTER_SLOTS_PER_ROW;
    if (name === "left") return column > 0 ? slot - 1 : undefined;
    if (name === "right") return column < FOOTER_SLOTS_PER_ROW - 1 ? slot + 1 : undefined;
    if (name === "up") return slot >= FOOTER_SLOTS_PER_ROW ? slot - FOOTER_SLOTS_PER_ROW : undefined;
    if (name === "down") return slot + FOOTER_SLOTS_PER_ROW < FOOTER_SLOT_COUNT ? slot + FOOTER_SLOTS_PER_ROW : undefined;
    return undefined;
}

function moved(state: FooterEditorState, change: Partial<FooterEditorState>): FooterEditorTransition {
    return { state: { ...state, ...change }, handled: true };
}

function putDown(state: FooterEditorState): FooterEditorState {
    const { carry: _carry, ...rest } = state;
    return rest;
}

function gated(state: FooterEditorState, layout: FooterLayout): FooterEditorTransition {
    const before = misfits(state.layout, state.seed);
    const added = [...misfits(layout, state.seed)].some((item) => !before.has(item));
    return added ? refuse(state, FOOTER_REFUSED_FIT) : moved(state, { layout });
}

function refuse(state: FooterEditorState, reason: string): FooterEditorTransition {
    return { state: { ...state, refused: reason }, handled: true };
}

// Items left out or cut short at the standard width, in either state.
export function footerMisfits(layout: FooterLayout, seed: FooterSeed): ReadonlySet<FooterItemId> {
    return misfits(layout, seed);
}

function misfits(layout: FooterLayout, seed: FooterSeed): Set<FooterItemId> {
    const out = new Set<FooterItemId>();
    for (const preview of ["idle", "working"] as const) {
        for (const [item, fate] of standardFit(layout, seed, preview).fates) {
            if (fate === "no room" || fate === "cut") out.add(item);
        }
    }
    return out;
}

function standardFit(layout: FooterLayout, seed: FooterSeed, preview: FooterPreview): FooterFit {
    return fitFooter(layout, seed[preview], preview === "working", FOOTER_STANDARD_COLUMNS);
}

function wrap(index: number, length: number): number {
    return ((index % length) + length) % length;
}

function otherPreview(preview: FooterPreview): FooterPreview {
    return preview === "idle" ? "working" : "idle";
}

function toggleShown(layout: FooterLayout, item: FooterItemId): FooterLayout {
    const hidden = layout.hidden.includes(item)
        ? layout.hidden.filter((entry) => entry !== item)
        : FOOTER_ITEM_IDS.filter((entry) => entry === item || layout.hidden.includes(entry));
    return { ...layout, hidden };
}
