import { useCallback, useRef, useState } from "react";

import { PinnedScrollState } from "./pinned-scroll.ts";

export interface PinnedScroll {
    readonly ref: (element: HTMLDivElement | null) => (() => void) | undefined;
    readonly onScroll: () => void;
    readonly preservePosition: () => void;
}

// Keeps a scroller at the bottom while its content grows, unless the reader scrolled up.
// Watches the content's size, not the data: off-screen turns change height after they render.
export function usePinnedScroll(): PinnedScroll {
    const [state] = useState(() => new PinnedScrollState());
    const scroller = useRef<HTMLDivElement | null>(null);
    const ref = useCallback((element: HTMLDivElement | null) => {
        scroller.current = element;
        const content = element?.firstElementChild;
        if (element === null || content === null || content === undefined) return undefined;
        const observer = new ResizeObserver(() => state.resized(element));
        observer.observe(content);
        return () => {
            observer.disconnect();
            scroller.current = null;
        };
    }, [state]);
    const onScroll = useCallback(() => {
        if (scroller.current !== null) state.scrolled(scroller.current);
    }, [state]);
    const preservePosition = useCallback(() => {
        if (scroller.current !== null) state.preservePosition(scroller.current);
    }, [state]);
    return { ref, onScroll, preservePosition };
}
