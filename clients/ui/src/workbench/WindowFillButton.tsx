import { useEffect, useSyncExternalStore } from "react";

import { RestoreIcon, WindowFillIcon } from "../components/Icons.tsx";

let filled = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function snapshot(): boolean {
    return filled;
}

function setFilled(value: boolean): void {
    if (filled === value) return;
    filled = value;
    if (typeof document !== "undefined") {
        document.documentElement.toggleAttribute("data-window-fill", value);
    }
    for (const listener of listeners) listener();
}

export function WindowFillButton() {
    const active = useSyncExternalStore(subscribe, snapshot, () => false);

    useEffect(() => {
        if (!active) return undefined;
        const restoreOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            const pane = document.querySelector('[data-location="rightPane"]');
            if (pane?.contains(document.activeElement)) setFilled(false);
        };
        document.addEventListener("keydown", restoreOnEscape);
        return () => document.removeEventListener("keydown", restoreOnEscape);
    }, [active]);

    return (
        <button
            type="button"
            className="icon-button"
            aria-label={active ? "Restore window" : "Fill window"}
            title={active ? "Restore window" : "Fill window"}
            aria-pressed={active}
            onClick={(event) => {
                setFilled(!active);
                if (!active) event.currentTarget.focus();
            }}
        >{active ? <RestoreIcon /> : <WindowFillIcon />}</button>
    );
}
