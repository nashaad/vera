import { useState, type CSSProperties, type KeyboardEvent } from "react";

import { ChevronRightIcon } from "../components/Icons.tsx";
import { allModels, NUMBERED_ROWS } from "./catalog.ts";
import type { ModelControls } from "./controls.ts";
import { buildMenuRows, moveFocus, numberKeySlot, pickOrder, providerLabel, rowTitle, shortlistSub } from "./menuRows.ts";
import { ModelMenuRow } from "./ModelMenuRow.tsx";
import type { ModelEntry, ModelSettings } from "./settings.ts";

export interface ModelMenuProps {
    readonly controls: ModelControls;
    readonly settings: ModelSettings;
    readonly onClose: () => void;
    readonly onBrowse: () => void;
    readonly style?: CSSProperties;
    // The search the menu opens with.
    readonly initialQuery?: string;
}

// The quick model picker. Favorites are what it offers; everything else is one search or one browse away.
export function ModelMenu({ controls, settings, onClose, onBrowse, style, initialQuery = "" }: ModelMenuProps) {
    const [query, setQuery] = useState(initialQuery);
    const [focus, setFocus] = useState<number | undefined>(undefined);
    const [reason, setReason] = useState<string | undefined>(undefined);
    const choice = controls.choice;
    const rows = buildMenuRows(settings, choice, query);
    const order = pickOrder(rows);
    const focused = focus === undefined ? undefined : order[focus];
    const running = rows.running;

    const pick = (entry: ModelEntry): void => {
        controls.actions.pick({ provider: entry.provider, model: entry.model });
        onClose();
    };
    const pin = (entry: ModelEntry): void => {
        setReason(undefined);
        void controls.actions.shortlist({ provider: entry.provider, model: entry.model }, true).then(setReason);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const slot = numberKeySlot(event.key, rows.searching);
        if (slot !== undefined) {
            event.preventDefault();
            const row = rows.shortlist[slot];
            if (row?.entry.available) pick(row.entry);
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setFocus(moveFocus(order.length, focus, event.key === "ArrowDown" ? 1 : -1));
            return;
        }
        if (event.key === "Enter" && focused !== undefined) {
            event.preventDefault();
            pick(focused);
        }
    };
    const nothingMatches = rows.searching && rows.running === undefined && rows.shortlist.length === 0 && rows.browse.length === 0;

    return (
        <div className="model-menu menu" role="menu" data-popover="above-end" style={style} onKeyDown={onKeyDown}>
            <label className="model-search">
                <input
                    autoFocus
                    placeholder="Search models"
                    aria-label="Search models"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setFocus(undefined);
                    }}
                />
            </label>
            {rows.searching ? null : (
                <>
                    <button type="button" className="menu-item model-item" aria-disabled="true" title="The host does not serve this">
                        <span className="model-item-name">Auto</span>
                    </button>
                    <div className="menu-separator" />
                </>
            )}
            {running === undefined ? null : (
                <>
                    <div className="model-label">Running, not in favorites</div>
                    <ModelMenuRow
                        entry={running}
                        sub={providerLabel(settings, running.provider)}
                        title={rowTitle(settings, running)}
                        current
                        focused={focused === running}
                        onPick={() => pick(running)}
                    />
                    <div className="menu-separator" />
                </>
            )}
            {settings.shortlist.length === 0 ? (
                <p className="model-empty">You have no favorites. Add some in All models.</p>
            ) : null}
            {rows.shortlist.map((row, index) => (
                <ModelMenuRow
                    key={`${row.entry.provider}/${row.entry.model}`}
                    entry={row.entry}
                    sub={shortlistSub(settings, row.entry)}
                    title={rowTitle(settings, row.entry)}
                    current={row.current}
                    focused={focused === row.entry}
                    hint={rows.searching || index >= NUMBERED_ROWS ? undefined : index + 1}
                    onPick={() => pick(row.entry)}
                />
            ))}
            {rows.browse.length === 0 ? null : (
                <>
                    <div className="model-label">Not in favorites</div>
                    {rows.browse.map((entry) => (
                        <ModelMenuRow
                            key={`${entry.provider}/${entry.model}`}
                            entry={entry}
                            sub={providerLabel(settings, entry.provider)}
                            title={rowTitle(settings, entry)}
                            current={false}
                            focused={focused === entry}
                            onPick={() => pick(entry)}
                            onPin={() => pin(entry)}
                        />
                    ))}
                </>
            )}
            {nothingMatches ? <p className="model-empty">No model matches</p> : null}
            {reason === undefined ? null : <p className="model-note">{reason}</p>}
            <div className="menu-separator" />
            <button type="button" className="menu-item model-item" aria-disabled="true" title="The host does not serve this">
                <span className="model-item-text">
                    <span className="model-item-name">Fast</span>
                    <span className="model-item-sub model-item-desc">Answer sooner; think less between tool calls</span>
                </span>
                <span className="model-switch" role="switch" aria-checked={false} aria-label="Fast">
                    <i />
                </span>
            </button>
            <div className="menu-separator" />
            <button
                type="button"
                className="menu-item model-item"
                onClick={() => {
                    onClose();
                    onBrowse();
                }}
            >
                <span className="model-item-name">All models…</span>
                <span className="model-count">{allModels(settings).length}</span>
                <ChevronRightIcon className="model-chevron" />
            </button>
        </div>
    );
}
