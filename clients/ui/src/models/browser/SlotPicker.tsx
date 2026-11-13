import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

import { CheckIcon } from "../../components/Icons.tsx";
import type { AssignedModel } from "../../protocol/assignments.ts";
import { browseRows, matchesQuery } from "../catalog.ts";
import { levelLabel, providerLabel } from "../menuRows.ts";
import type { ModelEntry, ModelSettings } from "../settings.ts";
import type { UnsetChoice } from "./defaults.ts";
import { entryKey } from "./rows.ts";

// Past this many, the rest of the catalog is reached by searching.
export const OTHER_LIMIT = 40;

export interface SlotPickerProps {
    readonly title: string;
    readonly settings: ModelSettings;
    readonly current: AssignedModel | undefined;
    // provider/model keys the picker leaves out.
    readonly exclude: ReadonlySet<string>;
    readonly unset: UnsetChoice | undefined;
    // False when the write takes no effort.
    readonly withEffort: boolean;
    readonly style: CSSProperties | undefined;
    readonly onPick: (value: AssignedModel | undefined) => void;
}

export interface PickerRows {
    readonly favorites: readonly ModelEntry[];
    readonly others: readonly ModelEntry[];
    // Catalog matches past OTHER_LIMIT.
    readonly more: number;
}

export function pickerRows(settings: ModelSettings, query: string, exclude: ReadonlySet<string>): PickerRows {
    const favorites = settings.shortlist.filter((entry) =>
        entry.available && !exclude.has(entryKey(entry)) && matchesQuery(entry, query));
    const favorite = new Set(settings.shortlist.map(entryKey));
    const matches = browseRows(settings.catalog, query, "any")
        .filter((entry) => !favorite.has(entryKey(entry)) && !exclude.has(entryKey(entry)));
    return { favorites, others: matches.slice(0, OTHER_LIMIT), more: Math.max(0, matches.length - OTHER_LIMIT) };
}

// The effort a pick uses unless one is chosen: the slot's own for its current model, else the model's default.
export function startingEffort(entry: ModelEntry, current: AssignedModel | undefined): string | undefined {
    const isCurrent = current !== undefined && current.provider === entry.provider && current.model === entry.model;
    if (isCurrent && current.effort !== undefined && entry.levels.some((level) => level.id === current.effort)) return current.effort;
    return entry.defaultLevel ?? entry.levels[0]?.id;
}

export function SlotPicker({ title, settings, current, exclude, unset, withEffort, style, onPick }: SlotPickerProps) {
    const [query, setQuery] = useState("");
    const [highlight, setHighlight] = useState(0);
    // The effort Left and Right chose for the highlighted row.
    const [effort, setEffort] = useState<string | undefined>(undefined);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const highlighted = useRef<HTMLDivElement>(null);

    const searching = query.trim().length > 0;
    const rows = pickerRows(settings, query, exclude);
    const showUnset = unset !== undefined && !searching;
    const order: readonly (ModelEntry | undefined)[] = [...(showUnset ? [undefined] : []), ...rows.favorites, ...rows.others];
    const active = order[highlight];

    // The popover is placed after its first layout, so autoFocus would scroll the sheet behind it.
    useEffect(() => {
        const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
        return () => cancelAnimationFrame(frame);
    }, []);

    // scrollIntoView would also scroll the sheet behind the popover.
    useLayoutEffect(() => {
        const box = list.current;
        const row = highlighted.current;
        if (box === null || row === null) return;
        if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) {
            box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
        }
    }, [highlight, query]);

    const effortOf = (entry: ModelEntry): string | undefined => {
        if (!withEffort) return undefined;
        return entry === active && effort !== undefined ? effort : startingEffort(entry, current);
    };
    const choose = (entry: ModelEntry | undefined, chosen?: string): void => {
        if (entry === undefined) {
            onPick(undefined);
            return;
        }
        const level = chosen ?? effortOf(entry);
        onPick({ provider: entry.provider, model: entry.model, ...(level === undefined ? {} : { effort: level }) });
    };
    const moveTo = (index: number): void => {
        setHighlight(index);
        setEffort(undefined);
    };
    const stepEffort = (step: 1 | -1): void => {
        if (active === undefined || !withEffort || active.levels.length === 0) return;
        const ids = active.levels.map((level) => level.id);
        const at = ids.indexOf(effortOf(active) ?? ids[0]!);
        setEffort(ids[Math.min(ids.length - 1, Math.max(0, at + step))]);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = highlight + (event.key === "ArrowDown" ? 1 : -1);
            moveTo(Math.min(order.length - 1, Math.max(0, next)));
        } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && active !== undefined && query.length === 0) {
            event.preventDefault();
            stepEffort(event.key === "ArrowRight" ? 1 : -1);
        } else if (event.key === "Enter" && order.length > 0) {
            event.preventDefault();
            choose(active);
        }
    };

    const isCurrent = (entry: ModelEntry): boolean =>
        current !== undefined && current.provider === entry.provider && current.model === entry.model;
    const row = (entry: ModelEntry, index: number) => {
        const on = index === highlight;
        const level = effortOf(entry);
        return (
            <div
                key={entryKey(entry)}
                ref={on ? highlighted : undefined}
                role="menuitemradio"
                aria-checked={isCurrent(entry)}
                className="menu-item model-item slot-pick"
                data-focused={on}
                title={`${entry.label} · ${providerLabel(settings, entry.provider)}`}
                onMouseMove={() => {
                    if (!on) moveTo(index);
                }}
                onClick={() => choose(entry)}
            >
                <span className="model-item-text">
                    <span className="model-item-name">{entry.shortLabel ?? entry.label}</span>
                    <span className="model-item-sub">{providerLabel(settings, entry.provider)}</span>
                </span>
                {on && withEffort && entry.levels.length > 0 ? (
                    <span className="slot-pick-efforts" title="Assign at this effort">
                        {entry.levels.map((option) => (
                            <button
                                key={option.id}
                                type="button"
                                tabIndex={-1}
                                className="slot-pick-effort"
                                aria-pressed={option.id === level}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    choose(entry, option.id);
                                }}
                            >
                                {option.label}
                            </button>
                        ))}
                    </span>
                ) : isCurrent(entry) && current?.effort !== undefined && withEffort ? (
                    <span className="model-item-sub">{levelLabel(entry.levels, current.effort)}</span>
                ) : null}
                <span className="slot-pick-check">{isCurrent(entry) ? <CheckIcon className="menu-check model-check" /> : null}</span>
            </div>
        );
    };
    const offset = showUnset ? 1 : 0;

    return (
        <div className="slot-picker menu" role="menu" aria-label={title} data-popover="below-end" style={style}>
            <div className="model-label slot-pick-title">{title}</div>
            <label className="model-search">
                <input
                    ref={input}
                    placeholder="Search models"
                    aria-label="Search models"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        moveTo(0);
                    }}
                    onKeyDown={onKeyDown}
                />
            </label>
            <div className="slot-pick-list" ref={list}>
                {showUnset ? (
                    <>
                        <div
                            ref={highlight === 0 ? highlighted : undefined}
                            role="menuitemradio"
                            aria-checked={current === undefined}
                            className="menu-item model-item slot-pick"
                            data-focused={highlight === 0}
                            onMouseMove={() => {
                                if (highlight !== 0) moveTo(0);
                            }}
                            onClick={() => choose(undefined)}
                        >
                            <span className="model-item-text">
                                <span className="model-item-name">{unset.label}</span>
                                <span className="model-item-sub model-item-desc">{unset.description}</span>
                            </span>
                            <span className="slot-pick-check">
                                {current === undefined ? <CheckIcon className="menu-check model-check" /> : null}
                            </span>
                        </div>
                        <div className="menu-separator" />
                    </>
                ) : null}
                {rows.favorites.length > 0 ? <div className="model-label">Favorites</div> : null}
                {rows.favorites.map((entry, index) => row(entry, index + offset))}
                {rows.others.length > 0 ? <div className="model-label">Other connected models</div> : null}
                {rows.others.map((entry, index) => row(entry, index + offset + rows.favorites.length))}
                {rows.more > 0 ? <p className="model-empty">{rows.more} more. Search to find them.</p> : null}
                {rows.favorites.length === 0 && rows.others.length === 0 ? <p className="model-empty">No model matches</p> : null}
            </div>
            <div className="slot-pick-foot">Any connected model can be assigned. It joins your favorites.</div>
        </div>
    );
}
