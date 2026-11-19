import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { PaletteRow } from "./CommandPalette.tsx";
import { rankItems, type PaletteItem, type RankedItem } from "./palette.ts";
import type { PickerRequest } from "./store.ts";

const CUT_NOTE = "More items are available than this list shows.";

function itemsOf(request: PickerRequest): readonly PaletteItem[] {
    return request.items.map((item): PaletteItem => ({
        id: item.key,
        label: item.label,
        group: "",
        detail: item.detail ?? "",
        age: "",
        keys: [],
        status: undefined,
        fields: item.detail === undefined ? [item.label] : [item.label, item.detail],
    }));
}

export interface PickerSheetProps {
    readonly request: PickerRequest;
    readonly onClose: () => void;
}

// A filterable list in the palette's look. Choosing closes it first, then hands the chosen key back.
export function PickerSheet({ request, onClose }: PickerSheetProps) {
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const items = useMemo(() => itemsOf(request), [request]);
    const ranked = useMemo(() => rankItems(items, query, items.length), [items, query]);
    const highlight = active < ranked.length ? active : 0;

    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }, [highlight]);

    const choose = (entry: RankedItem) => {
        onClose();
        request.choose(entry.item.id);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const count = ranked.length;
            if (count === 0) return;
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current) => (current + step + count) % count);
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            const entry = ranked[highlight];
            if (entry !== undefined) choose(entry);
        }
    };

    return (
        <div
            className="sheet-scrim palette-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="palette" role="dialog" aria-modal="true" aria-label={request.title} data-overlay="picker" onKeyDown={onKeyDown}>
                <div className="palette-input">
                    <input
                        autoFocus
                        aria-label={request.title}
                        placeholder="Type to filter"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setActive(0);
                        }}
                    />
                </div>
                <div className="palette-list" role="listbox" ref={listRef}>
                    {ranked.length === 0 ? <div className="palette-empty">No matches</div> : null}
                    {ranked.map((entry, index) => (
                        <PaletteRow
                            key={entry.item.id}
                            mode="pick"
                            entry={entry}
                            selected={index === highlight}
                            onHover={() => setActive(index)}
                            onRun={() => choose(entry)}
                        />
                    ))}
                    {request.cut ? <div className="palette-empty">{CUT_NOTE}</div> : null}
                </div>
                <div className="palette-foot" aria-hidden="true">
                    <span><kbd className="kbd">↑↓</kbd>Select</span>
                    <span><kbd className="kbd">↵</kbd>Choose</span>
                    <span><kbd className="kbd">esc</kbd>Close</span>
                </div>
            </div>
        </div>
    );
}
