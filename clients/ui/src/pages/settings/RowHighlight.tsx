import { createContext, useCallback, useContext, useLayoutEffect, useReducer, type RefObject } from "react";

export interface RowHighlight {
    readonly rowId: string | undefined;
    // Changes on every pick of a row, so a repeat pick replays the sheen.
    readonly sheen: number;
    // True once the row is centered and the layout is still, so the sheen is not spent off screen.
    readonly sheenReady: boolean;
}

export type RowHighlightAction =
    | { readonly kind: "row"; readonly rowId: string }
    | { readonly kind: "section" }
    | { readonly kind: "sheen" };

// A row pick moves the highlight and withholds its sheen; a repeat pick keeps it and replays the sheen; a section pick clears it.
export function nextRowHighlight(state: RowHighlight, action: RowHighlightAction): RowHighlight {
    if (action.kind === "section") return state.rowId === undefined ? state : { ...state, rowId: undefined, sheenReady: false };
    if (action.kind === "sheen") return state.sheenReady ? state : { ...state, sheenReady: true };
    return { rowId: action.rowId, sheen: state.sheen + 1, sheenReady: false };
}

const NO_HIGHLIGHT: RowHighlight = { rowId: undefined, sheen: 0, sheenReady: false };

export const RowHighlightContext = createContext<RowHighlight>(NO_HIGHLIGHT);

// The attributes a row carries while the search highlight names it. The sheen alternates two names so a repeat pick restarts it.
export function useSearchHit(rowId: string | undefined): Readonly<Record<string, string>> {
    const highlight = useContext(RowHighlightContext);
    if (rowId === undefined || rowId !== highlight.rowId) return {};
    const attributes: Record<string, string> = { "data-search-hit": "true" };
    if (highlight.sheenReady) attributes["data-sheen"] = highlight.sheen % 2 === 0 ? "a" : "b";
    return attributes;
}

export interface RowHighlightHandle extends RowHighlight {
    show: (rowId: string) => void;
    clear: () => void;
}

// The follow loop stops after this long without a layout change, or at the cap below.
export const FOLLOW_STILL_MS = 1_000;
export const FOLLOW_LIMIT_MS = 5_000;
// Stillness this short means the row is in place, so its sheen can start.
export const SHEEN_STILL_MS = 200;

export function followStopped(pickedAt: number, lastChangeAt: number, now: number): boolean {
    return now - pickedAt >= FOLLOW_LIMIT_MS || now - lastChangeAt >= FOLLOW_STILL_MS;
}

// Finds a row by its id after its section renders and keeps it centered while the section's layout settles.
// The row itself carries the highlight; the sheen waits until the row is still.
export function useRowHighlight(container: RefObject<HTMLElement | null>): RowHighlightHandle {
    const [state, dispatch] = useReducer(nextRowHighlight, NO_HIGHLIGHT);

    useLayoutEffect(() => {
        const node = container.current;
        if (state.rowId === undefined || node === null) return;
        const rowId = state.rowId;
        let pickedAt = 0;
        let lastChangeAt = 0;
        let stopped = false;
        let sheenPlayed = false;
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        let sheenTimer: ReturnType<typeof setTimeout> | undefined;
        let watchingRow: MutationObserver | undefined;

        const findRow = (): HTMLElement | null => {
            const row = node.querySelector(`[data-setting-id="${CSS.escape(rowId)}"]`);
            return row instanceof HTMLElement ? row : null;
        };
        const stop = (): void => {
            if (stopped) return;
            stopped = true;
            if (stopTimer !== undefined) clearTimeout(stopTimer);
            if (sheenTimer !== undefined) clearTimeout(sheenTimer);
            resize.disconnect();
            watchingRow?.disconnect();
            watchingRow = undefined;
            node.removeEventListener("wheel", stop, true);
            node.removeEventListener("touchstart", stop, true);
            node.removeEventListener("pointerdown", stop, true);
            node.removeEventListener("keydown", stop, true);
        };
        const scheduleStop = (): void => {
            if (stopTimer !== undefined) clearTimeout(stopTimer);
            const now = performance.now();
            const due = Math.min(pickedAt + FOLLOW_LIMIT_MS, lastChangeAt + FOLLOW_STILL_MS);
            stopTimer = setTimeout(() => {
                if (followStopped(pickedAt, lastChangeAt, performance.now())) stop();
                else scheduleStop();
            }, Math.max(0, due - now));
        };
        const scheduleSheen = (): void => {
            if (sheenPlayed) return;
            if (sheenTimer !== undefined) clearTimeout(sheenTimer);
            sheenTimer = setTimeout(() => {
                sheenPlayed = true;
                if (!stopped) dispatch({ kind: "sheen" });
            }, SHEEN_STILL_MS);
        };
        const recenter = (): boolean => {
            const row = findRow();
            if (row === null) return false;
            const now = performance.now();
            if (pickedAt === 0) pickedAt = now;
            row.scrollIntoView({ block: "center", behavior: "auto" });
            lastChangeAt = now;
            scheduleStop();
            scheduleSheen();
            return true;
        };
        const watchForRow = (): void => {
            if (watchingRow !== undefined) return;
            watchingRow = new MutationObserver(() => {
                if (!recenter()) return;
                watchingRow?.disconnect();
                watchingRow = undefined;
            });
            watchingRow.observe(node, { childList: true, subtree: true });
        };

        const resize = new ResizeObserver(() => {
            if (stopped) return;
            if (!recenter()) watchForRow();
        });
        const column = node.querySelector(".settings-col");
        if (column instanceof HTMLElement) resize.observe(column);

        // Any of these means the user took over the column, so the row stops being recentered.
        node.addEventListener("wheel", stop, { capture: true, passive: true });
        node.addEventListener("touchstart", stop, { capture: true, passive: true });
        node.addEventListener("pointerdown", stop, true);
        node.addEventListener("keydown", stop, true);

        if (!recenter()) watchForRow();
        return stop;
    }, [container, state.rowId, state.sheen]);

    const show = useCallback((rowId: string) => dispatch({ kind: "row", rowId }), []);
    const clear = useCallback(() => dispatch({ kind: "section" }), []);
    return { rowId: state.rowId, sheen: state.sheen, sheenReady: state.sheenReady, show, clear };
}
