import { useLayoutEffect, useState, type RefObject } from "react";

// Below this many space units the rail keeps only its icons, so the section keeps the width.
const FULL_RAIL_SPACES = 150;

export function railNarrow(width: number, space: number): boolean {
    return space > 0 && width < space * FULL_RAIL_SPACES;
}

// Density and theme change the space token without resizing the page, so the root is watched too.
export function useNarrowRail(split: RefObject<HTMLElement | null>): boolean {
    const [narrow, setNarrow] = useState(false);
    useLayoutEffect(() => {
        const node = split.current;
        if (node === null) return undefined;
        const fit = (): void => {
            const space = Number.parseFloat(getComputedStyle(node).getPropertyValue("--vera-space"));
            setNarrow(railNarrow(node.clientWidth, space));
        };
        fit();
        const resized = new ResizeObserver(fit);
        resized.observe(node);
        const restyled = new MutationObserver(fit);
        restyled.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-density"] });
        return () => {
            resized.disconnect();
            restyled.disconnect();
        };
    }, [split]);
    return narrow;
}
