import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const EDGE = 8;

type SlashPlacement = CSSProperties & { readonly "--popover-room": string };

// Puts the menu above the composer at its width, kept inside the window. The menu is
// position: fixed, so it takes no room in the composer bar and cannot be clipped by it.
export function useSlashPlacement(
    anchor: RefObject<HTMLElement | null>,
    menu: RefObject<HTMLElement | null>,
): SlashPlacement | undefined {
    const [style, setStyle] = useState<SlashPlacement | undefined>(undefined);
    useLayoutEffect(() => {
        const element = anchor.current;
        if (element === null) return undefined;
        const place = (): void => {
            const box = element.getBoundingClientRect();
            const gap = menu.current === null ? 0 : parseFloat(getComputedStyle(menu.current).marginBottom);
            const left = Math.max(EDGE, box.left);
            const width = Math.max(0, Math.min(box.right, window.innerWidth - EDGE) - left);
            setStyle({
                left,
                width,
                bottom: window.innerHeight - box.top,
                "--popover-room": `${box.top - gap - EDGE}px`,
            });
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(element);
        window.addEventListener("resize", place);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", place);
        };
    }, [anchor, menu]);
    return style;
}
