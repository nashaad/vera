import type { LayoutState } from "./model.ts";

export interface LayoutSaver {
    schedule(layout: LayoutState): void;
    // Writes any pending layout now; used when the window is going away.
    flush(): void;
}

// Waits for a quiet moment so a sash drag becomes one write.
export function createLayoutSaver(
    save: (layout: LayoutState) => void,
    delayMs: number,
): LayoutSaver {
    let pending: LayoutState | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        const layout = pending;
        pending = undefined;
        if (layout !== undefined) save(layout);
    };
    return {
        schedule(layout) {
            pending = layout;
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(flush, delayMs);
        },
        flush,
    };
}
