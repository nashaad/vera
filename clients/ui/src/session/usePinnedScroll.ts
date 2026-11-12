import { useCallback, useRef } from "react";

const PINNED_SLACK_PX = 48;

export interface PinnedScroll {
    readonly ref: (element: HTMLDivElement | null) => (() => void) | undefined;
    readonly onScroll: () => void;
}

// Keeps a scroller at the bottom while its content grows, unless the reader scrolled up.
// Watches the content's size, not the data: off-screen turns change height after they render.
export function usePinnedScroll(): PinnedScroll {
    const pinned = useRef(true);
    const scroller = useRef<HTMLDivElement | null>(null);
    const ref = useCallback((element: HTMLDivElement | null) => {
        scroller.current = element;
        const content = element?.firstElementChild;
        if (element === null || content === null || content === undefined) return undefined;
        const observer = new ResizeObserver(() => {
            if (pinned.current) element.scrollTop = element.scrollHeight;
        });
        observer.observe(content);
        return () => {
            observer.disconnect();
            scroller.current = null;
        };
    }, []);
    const lastTop = useRef(0);
    const lastHeight = useRef(0);
    // Only a move up releases the pin: content can grow between a scroll and its event, which looks like distance from the bottom.
    // A move up while the content changed size is the browser keeping the view anchored, not the reader.
    const onScroll = useCallback(() => {
        const element = scroller.current;
        if (element === null) return;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_SLACK_PX;
        if (nearBottom) pinned.current = true;
        else if (element.scrollTop < lastTop.current && element.scrollHeight === lastHeight.current) pinned.current = false;
        lastTop.current = element.scrollTop;
        lastHeight.current = element.scrollHeight;
    }, []);
    return { ref, onScroll };
}
