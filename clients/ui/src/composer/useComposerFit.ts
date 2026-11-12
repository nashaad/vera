import { useLayoutEffect, type RefObject } from "react";

// From roomiest to tightest. composer.css hides more of the bar's pills at each step.
const FITS = ["full", "compact", "tight"] as const;

// Sets the bar's data-fit to the roomiest step whose pill labels are not cut short.
export function useComposerFit(bar: RefObject<HTMLDivElement | null>): void {
    useLayoutEffect(() => {
        const node = bar.current;
        if (node === null) return undefined;
        const fit = (): void => fitBar(node);
        fit();
        const resized = new ResizeObserver(fit);
        resized.observe(node);
        // A new model name or mode changes how much room the pills need. Our own data-fit writes are
        // attributes, which this does not watch, so it cannot loop.
        const changed = new MutationObserver(fit);
        changed.observe(node, { childList: true, characterData: true, subtree: true });
        return () => {
            resized.disconnect();
            changed.disconnect();
        };
    }, [bar]);
}

// Each step forces one layout of the bar; observer callbacks run before paint, so no step shows.
function fitBar(bar: HTMLElement): void {
    for (const fit of FITS) {
        bar.dataset.fit = fit;
        if (!cutShort(bar)) return;
    }
}

function cutShort(bar: HTMLElement): boolean {
    // Rounding can make a whole label read one pixel short, so a bar with room to spare never counts.
    const spare = bar.querySelector(".grow");
    if (spare !== null && spare.getBoundingClientRect().width >= 1) return false;
    return [...bar.querySelectorAll<HTMLElement>(".pill-label, .pill-sub")].some((label) => label.scrollWidth > label.clientWidth);
}
