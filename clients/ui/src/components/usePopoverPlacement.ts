import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const EDGE = 8;

type PlacedStyle = CSSProperties & { readonly "--popover-room": string };

// The popover is the root's direct child marked data-popover="<above|below>-<start|end>". It is
// position: fixed, so a narrow pane cannot clip it; the returned style keeps it inside the window.
export function usePopoverPlacement(open: boolean, root: RefObject<HTMLElement | null>): PlacedStyle | undefined {
    const [style, setStyle] = useState<PlacedStyle | undefined>(undefined);
    useLayoutEffect(() => {
        if (!open) return undefined;
        const place = (): void => {
            const anchor = root.current;
            const popover = anchor?.querySelector<HTMLElement>(":scope > [data-popover]");
            if (anchor === null || anchor === undefined || popover === null || popover === undefined) return;
            const [side, align] = (popover.dataset.popover ?? "").split("-");
            const box = anchor.getBoundingClientRect();
            const width = popover.offsetWidth;
            const preferred = align === "end" ? box.right - width : box.left;
            const left = Math.max(EDGE, Math.min(preferred, window.innerWidth - width - EDGE));
            const margins = getComputedStyle(popover);
            setStyle(side === "below"
                ? { left, top: box.bottom, "--popover-room": `${window.innerHeight - box.bottom - parseFloat(margins.marginTop) - EDGE}px` }
                : { left, bottom: window.innerHeight - box.top, "--popover-room": `${box.top - parseFloat(margins.marginBottom) - EDGE}px` });
        };
        place();
        window.addEventListener("resize", place);
        return () => window.removeEventListener("resize", place);
    }, [open, root]);
    return style;
}
