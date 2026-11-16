import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

import { placePopover } from "./placePopover.ts";

const EDGE = 8;
const ROOM = "--popover-room";

type PlacedStyle = CSSProperties & { readonly "--popover-room": string };

// The popover is the root's direct child marked data-popover="<above|below>-<start|end>". It is
// position: fixed, so a narrow pane cannot clip it; the returned style keeps it inside the nearest
// sheet or dialog, else the window, and flips it to the other side when that side has more room.
export function usePopoverPlacement(open: boolean, root: RefObject<HTMLElement | null>): PlacedStyle | undefined {
    const [style, setStyle] = useState<PlacedStyle | undefined>(undefined);
    useLayoutEffect(() => {
        if (!open) return undefined;
        const place = (): void => {
            const anchor = root.current;
            const popover = anchor?.querySelector<HTMLElement>(":scope > [data-popover]");
            if (anchor === null || anchor === undefined || popover === null || popover === undefined) return;
            const [side, align] = (popover.dataset.popover ?? "").split("-");
            const margins = getComputedStyle(popover);
            const sheet = anchor.closest("[aria-modal=\"true\"], dialog");
            const placed = placePopover({
                side: side === "below" ? "below" : "above",
                align: align === "end" ? "end" : "start",
                anchor: anchor.getBoundingClientRect(),
                bound: sheet?.getBoundingClientRect(),
                viewport: { width: window.innerWidth, height: window.innerHeight },
                width: popover.offsetWidth,
                height: uncappedHeight(popover),
                gap: parseFloat(side === "below" ? margins.marginTop : margins.marginBottom),
                edge: EDGE,
            });
            const { room, ...inset } = placed;
            setStyle({ ...inset, [ROOM]: `${room}px` });
        };
        place();
        window.addEventListener("resize", place);
        return () => window.removeEventListener("resize", place);
    }, [open, root]);
    return style;
}

// A popover capped by its last room would otherwise report that cap as the height it needs; the window is the most it can take.
function uncappedHeight(popover: HTMLElement): number {
    const held = popover.style.getPropertyValue(ROOM);
    popover.style.setProperty(ROOM, `${window.innerHeight}px`);
    const height = popover.offsetHeight;
    if (held === "") popover.style.removeProperty(ROOM);
    else popover.style.setProperty(ROOM, held);
    return height;
}
