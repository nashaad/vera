import { createContext, useCallback, useContext, useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";

export type DragPayload =
    | { readonly kind: "view"; readonly id: string }
    | { readonly kind: "container"; readonly id: string };

interface DragApi {
    readonly payload: DragPayload | undefined;
    // The id of the drop target the pointer is over, so only the innermost one lights up.
    readonly hover: string | undefined;
    readonly setHover: (id: string | undefined) => void;
    readonly start: (payload: DragPayload, event: DragEvent) => void;
    readonly end: () => void;
}

const DragContext = createContext<DragApi | undefined>(undefined);

const MIME = "application/x-vera-layout";

export function DragProvider({ children }: { readonly children: ReactNode }) {
    const [payload, setPayload] = useState<DragPayload | undefined>(undefined);
    const [hover, setHover] = useState<string | undefined>(undefined);

    const end = useCallback((): void => {
        setPayload(undefined);
        setHover(undefined);
    }, []);

    const start = useCallback((next: DragPayload, event: DragEvent): void => {
        event.dataTransfer.setData(MIME, JSON.stringify(next));
        event.dataTransfer.setData("text/plain", next.id);
        event.dataTransfer.effectAllowed = "move";
        // Changing the DOM inside dragstart cancels the drag, so the targets appear a tick later.
        setTimeout(() => setPayload(next), 0);
    }, []);

    // The dragged element can be gone by the time the drop lands, so dragend may never reach it.
    useEffect(() => {
        const finish = (): void => {
            setTimeout(end, 0);
        };
        window.addEventListener("dragend", finish, true);
        window.addEventListener("drop", finish, true);
        return () => {
            window.removeEventListener("dragend", finish, true);
            window.removeEventListener("drop", finish, true);
        };
    }, [end]);

    const api = useMemo<DragApi>(() => ({ payload, hover, setHover, start, end }), [payload, hover, start, end]);
    return <DragContext.Provider value={api}>{children}</DragContext.Provider>;
}

export function useDrag(): DragApi {
    const api = useContext(DragContext);
    if (api === undefined) throw new Error("useDrag needs a DragProvider.");
    return api;
}

export interface DropTarget {
    // A drag this target accepts is in progress.
    readonly active: boolean;
    // The pointer is over this target and no inner target.
    readonly over: boolean;
    readonly props: {
        readonly onDragOver?: (event: DragEvent) => void;
        readonly onDragLeave?: (event: DragEvent) => void;
        readonly onDrop?: (event: DragEvent) => void;
    };
}

export interface DropOptions {
    readonly id: string;
    readonly accepts: (payload: DragPayload) => boolean;
    readonly onDrop: (payload: DragPayload, event: DragEvent) => void;
    // Called on every dragover, for targets that track where inside them the pointer is.
    readonly onOver?: (event: DragEvent) => void;
}

export function useDropTarget({ id, accepts, onDrop, onOver }: DropOptions): DropTarget {
    const { payload, hover, setHover, end } = useDrag();
    const active = payload !== undefined && accepts(payload);
    if (!active) return { active: false, over: false, props: {} };
    return {
        active,
        over: hover === id,
        props: {
            onDragOver: (event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setHover(id);
                onOver?.(event);
            },
            onDragLeave: (event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) return;
                if (hover === id) setHover(undefined);
            },
            onDrop: (event) => {
                event.preventDefault();
                event.stopPropagation();
                onDrop(payload, event);
                end();
            },
        },
    };
}

// How many of the entries lie before the pointer along the axis: the index a drop would take
// among them. Pass only the entries still in place, never the one being dragged.
export function dropIndex(
    rects: readonly { readonly start: number; readonly size: number }[],
    pointer: number,
): number {
    let index = 0;
    for (const rect of rects) {
        if (pointer > rect.start + rect.size / 2) index += 1;
    }
    return index;
}
