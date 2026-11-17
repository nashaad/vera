import { useEffect, useRef } from "react";

import { nativeCommand } from "./native.ts";
import type { BrowserBounds } from "./native-types.ts";

const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"], .sheet-scrim, .wizard-scrim, [data-popover]';

// Reports where the shell's page is drawn over the returned element. Only a view that shows a page
// reports, and it reports nothing at all when it hides, so views that stay mounted never fight over
// the one native surface.
export function useNativeSurface(show: boolean) {
    const surface = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!show) return;
        let frame = 0;
        let last = "";
        const send = (bounds: BrowserBounds | null): void => {
            const key = JSON.stringify(bounds);
            if (key === last) return;
            last = key;
            void nativeCommand("bounds", bounds);
        };
        const update = (): void => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                const element = surface.current;
                if (element === null) {
                    send(null);
                    return;
                }
                const rect = element.getBoundingClientRect();
                const overlay = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((node) => {
                    if (node.getClientRects().length === 0 || getComputedStyle(node).visibility === "hidden") return false;
                    const box = node.getBoundingClientRect();
                    return box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
                });
                if (overlay) {
                    send(null);
                    return;
                }
                if (rect.width <= 0 || rect.height <= 0) {
                    send(null);
                    return;
                }
                send({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
            });
        };
        const observer = new MutationObserver(update);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
        const resize = new ResizeObserver(update);
        if (surface.current !== null) resize.observe(surface.current);
        window.addEventListener("resize", update);
        update();
        return () => {
            observer.disconnect();
            resize.disconnect();
            window.removeEventListener("resize", update);
            window.cancelAnimationFrame(frame);
            if (last !== "" && last !== "null") void nativeCommand("bounds", null);
        };
    }, [show]);

    return surface;
}
