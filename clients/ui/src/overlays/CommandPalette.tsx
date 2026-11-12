import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { CommandRegistry } from "../commands/registry.ts";
import { useRouter } from "../pages/router.tsx";
import { useViewEnvironment } from "../views/env.tsx";
import {
    buildCommandItems,
    buildSessionItems,
    labelSegments,
    rankItems,
    sectionRows,
    type PaletteItem,
    type RankedItem,
} from "./palette.ts";

export interface CommandPaletteProps {
    readonly mode: "commands" | "sessions";
    readonly commands: CommandRegistry;
    readonly onClose: () => void;
}

const COPY = {
    commands: {
        label: "Command palette",
        placeholder: "Type a command name",
        none: "No commands yet",
        noMatch: "No matching commands",
    },
    sessions: {
        label: "Go to session",
        placeholder: "Go to a session",
        none: "No sessions yet",
        noMatch: "No matching sessions",
    },
} as const;

// Runs the chosen entry. The palette closes first so a sheet the command opens replaces it.
export function CommandPalette({ mode, commands, onClose }: CommandPaletteProps) {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const platform = window.veraDesktop?.platform ?? "";
    const sessionRows = connection.sessionRows;

    const items = useMemo<readonly PaletteItem[]>(
        () => mode === "commands"
            ? buildCommandItems(commands.list(), platform)
            : buildSessionItems(sessionRows ?? [], Date.now()),
        [mode, commands, platform, sessionRows],
    );
    const ranked = useMemo(() => rankItems(items, query), [items, query]);
    const sections = useMemo(() => sectionRows(ranked), [ranked]);
    const highlight = active < ranked.length ? active : 0;

    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }, [highlight]);

    const choose = (entry: RankedItem) => {
        onClose();
        if (mode === "commands") {
            commands.execute(entry.item.id);
            return;
        }
        navigate({ kind: "session", agentId: entry.item.id, title: entry.item.label });
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

    const copy = COPY[mode];
    const emptyText = items.length === 0 ? copy.none : copy.noMatch;

    return (
        <div
            className="sheet-scrim palette-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className="palette"
                role="dialog"
                aria-modal="true"
                data-overlay={mode === "commands" ? "palette" : "sessions"}
                onKeyDown={onKeyDown}
            >
                <div className="palette-input">
                    <input
                        autoFocus
                        aria-label={copy.label}
                        placeholder={copy.placeholder}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setActive(0);
                        }}
                    />
                </div>
                <div className="palette-list" role="listbox" ref={listRef}>
                    {ranked.length === 0 ? <div className="palette-empty">{emptyText}</div> : null}
                    {sections.map((section) => (
                        <div key={section.title || "all"} role="presentation">
                            {section.title === "" ? null : <div className="palette-group">{section.title}</div>}
                            {section.entries.map((entry) => (
                                <PaletteRow
                                    key={entry.ranked.item.id}
                                    mode={mode}
                                    entry={entry.ranked}
                                    selected={entry.index === highlight}
                                    onHover={() => setActive(entry.index)}
                                    onRun={() => choose(entry.ranked)}
                                />
                            ))}
                        </div>
                    ))}
                </div>
                <div className="palette-foot" aria-hidden="true">
                    <span><kbd className="kbd">↑↓</kbd>Select</span>
                    <span><kbd className="kbd">↵</kbd>{mode === "commands" ? "Run" : "Open"}</span>
                    <span><kbd className="kbd">esc</kbd>Close</span>
                </div>
            </div>
        </div>
    );
}

interface PaletteRowProps {
    readonly mode: "commands" | "sessions";
    readonly entry: RankedItem;
    readonly selected: boolean;
    readonly onHover: () => void;
    readonly onRun: () => void;
}

function PaletteRow({ mode, entry, selected, onHover, onRun }: PaletteRowProps) {
    const { item } = entry;
    return (
        <button
            type="button"
            role="option"
            aria-selected={selected}
            className="palette-row"
            data-command={mode === "commands" ? item.id : undefined}
            data-session={mode === "sessions" ? item.id : undefined}
            onMouseEnter={onHover}
            onClick={onRun}
        >
            {item.status === undefined ? null : <span className="palette-dot" data-status={item.status} aria-hidden="true" />}
            <span className="palette-row-label">
                {labelSegments(item.label, entry.indices).map((segment, index) => (
                    <span key={index} className={segment.hit ? "palette-hit" : undefined}>{segment.text}</span>
                ))}
            </span>
            {item.detail === "" ? null : <span className="palette-row-detail">{item.detail}</span>}
            {item.age === "" ? null : <span className="palette-row-age">{item.age}</span>}
            {item.keys.length === 0 ? null : (
                <span className="palette-row-keys">
                    {item.keys.map((key, index) => <kbd className="kbd" key={index}>{key}</kbd>)}
                </span>
            )}
        </button>
    );
}
