import { useEffect, useRef, type KeyboardEvent } from "react";

import { ImageIcon, PinIcon } from "../../components/Icons.tsx";
import type { ModelChoice, ModelEntry } from "../settings.ts";
import { blendedText, entryKey, isCurrent, waText } from "./rows.ts";

export interface ModelListProps {
    readonly rows: readonly ModelEntry[];
    readonly selectedKey: string | undefined;
    readonly choice: ModelChoice | undefined;
    readonly pinned: ReadonlySet<string>;
    readonly enabled: boolean;
    readonly providerName: (provider: string) => string;
    readonly onSelect: (entry: ModelEntry) => void;
    readonly onPin: (entry: ModelEntry, on: boolean) => void;
}

export function ModelList({ rows, selectedKey, choice, pinned, enabled, providerName, onSelect, onPin }: ModelListProps) {
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        listRef.current?.querySelector('[data-on="true"]')?.scrollIntoView({ block: "nearest" });
    }, [selectedKey]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        if (rows.length === 0) return;
        event.preventDefault();
        const index = rows.findIndex((entry) => entryKey(entry) === selectedKey);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + step));
        onSelect(rows[next]!);
    };

    return (
        <div className="models-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
            <div className="models-row models-row-head">
                <span className="models-cell models-col-name">Model</span>
                <span className="models-cell models-col-wa">WA</span>
                <span className="models-cell models-col-price">$/M</span>
                <span className="models-cell models-col-front">P</span>
                <span className="models-cell models-col-image" />
                <span className="models-cell models-col-pin" />
            </div>
            {rows.map((entry) => {
                const key = entryKey(entry);
                const on = pinned.has(key);
                return (
                    <div
                        key={key}
                        className="models-row"
                        data-on={key === selectedKey}
                        data-current={isCurrent(entry, choice)}
                        onClick={() => onSelect(entry)}
                    >
                        <span className="models-cell models-col-name">
                            <span className="models-name" title={entry.label}>{entry.shortLabel ?? entry.label}</span>
                            <span className="models-sub">
                                {entry.maker === undefined ? "" : `${entry.maker} · `}
                                {providerName(entry.provider)}
                                {entry.available ? "" : " · not offered now"}
                            </span>
                        </span>
                        <span className="models-cell models-col-wa">{waText(entry)}</span>
                        <span className="models-cell models-col-price">{blendedText(entry)}</span>
                        <span className="models-cell models-col-front" data-yes={entry.onPareto}>
                            {entry.onPareto ? "P" : ""}
                        </span>
                        <span className="models-cell models-col-image">
                            {entry.imageSupport === true && <ImageIcon className="models-image" />}
                        </span>
                        <span className="models-cell models-col-pin">
                            <button
                                type="button"
                                className="models-pin"
                                data-on={on}
                                disabled={!enabled}
                                aria-label={on ? "Remove from favorites" : "Add to favorites"}
                                title={on ? "Remove from favorites" : "Add to favorites"}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onPin(entry, !on);
                                }}
                            >
                                <PinIcon className="models-pin-icon" />
                            </button>
                        </span>
                    </div>
                );
            })}
            {rows.length === 0 && <div className="models-empty">No models match.</div>}
        </div>
    );
}
