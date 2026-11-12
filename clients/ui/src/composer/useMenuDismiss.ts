import { useEffect, type RefObject } from "react";

// Closes an open popover on a press outside its root, or on Escape.
export function useMenuDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void): void {
    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: MouseEvent): void => {
            if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) close();
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") close();
        };
        document.addEventListener("mousedown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open, root, close]);
}
