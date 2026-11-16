export interface Box {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
}

export interface PopoverPlacementInput {
    readonly side: "above" | "below";
    readonly align: "start" | "end";
    readonly anchor: Box;
    // The enclosing sheet or dialog; the window alone when undefined.
    readonly bound: Box | undefined;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly width: number;
    // Height without the room cap, so a popover that was squeezed once can grow back.
    readonly height: number;
    // The CSS margin on the preferred side, kept as the gap when the popover flips.
    readonly gap: number;
    readonly edge: number;
}

export interface PopoverPlacement {
    readonly left: number;
    readonly top?: number;
    readonly bottom?: number;
    readonly room: number;
}

export function placePopover(input: PopoverPlacementInput): PopoverPlacement {
    const { anchor, viewport, width, height, gap, edge } = input;
    const bound = input.bound === undefined ? windowBox(viewport) : intersect(input.bound, windowBox(viewport));
    const below = bound.bottom - anchor.bottom - gap - edge;
    const above = anchor.top - bound.top - gap - edge;
    const preferred = input.side === "below" ? below : above;
    const other = input.side === "below" ? above : below;
    const flipped = height > preferred && other > preferred;
    const side = flipped ? (input.side === "below" ? "above" : "below") : input.side;

    const wanted = input.align === "end" ? anchor.right - width : anchor.left;
    const left = Math.max(bound.left + edge, Math.min(wanted, bound.right - width - edge));
    // The CSS margin sits on the preferred side only, so a flipped popover carries the gap in its inset.
    const inset = flipped ? gap : 0;
    const room = Math.max(0, side === "below" ? below : above);
    return side === "below"
        ? { left, top: anchor.bottom + inset, room }
        : { left, bottom: viewport.height - anchor.top + inset, room };
}

function windowBox(viewport: { readonly width: number; readonly height: number }): Box {
    return { top: 0, left: 0, right: viewport.width, bottom: viewport.height };
}

function intersect(a: Box, b: Box): Box {
    return {
        top: Math.max(a.top, b.top),
        left: Math.max(a.left, b.left),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };
}
