import { Fragment, useEffect, useRef, type RefObject } from "react";

import { NOT_IMPLEMENTED, SLASH_GROUPS, SLASH_GROUP_TITLES, type SlashEntry } from "./model.ts";
import { useSlashPlacement } from "./useSlashPlacement.ts";

export interface SlashMenuView {
    readonly entries: readonly SlashEntry[];
    readonly active: number;
    readonly onPick: (entry: SlashEntry) => void;
    readonly onHover: (index: number) => void;
}

export const SLASH_MENU_ID = "slash-menu";

export function slashOptionId(entry: SlashEntry): string {
    return `slash-option-${entry.group}-${entry.name}`;
}

export interface SlashMenuProps {
    readonly view: SlashMenuView;
    // The composer box the menu sits above.
    readonly anchor: RefObject<HTMLElement | null>;
}

// What follows the name in the usage line, such as "[level]", plus any alias.
function hint(entry: SlashEntry): string {
    const prefix = `/${entry.name}`;
    const parts = [entry.usage.startsWith(prefix) ? entry.usage.slice(prefix.length).trim() : ""];
    if (entry.aliases.length > 0) parts.push(`also ${entry.aliases.map((alias) => `/${alias}`).join(" ")}`);
    return parts.filter((part) => part.length > 0).join(" ");
}

export function SlashMenu({ view, anchor }: SlashMenuProps) {
    const menu = useRef<HTMLDivElement>(null);
    const placed = useSlashPlacement(anchor, menu);
    const { entries, active } = view;

    useEffect(() => {
        menu.current?.querySelector('[data-focused="true"]')?.scrollIntoView({ block: "nearest" });
    }, [active, entries]);

    return (
        <div
            id={SLASH_MENU_ID}
            ref={menu}
            className="menu slash-menu"
            role="listbox"
            aria-label="Slash commands"
            style={placed}
            // Keeps the caret in the composer while a row is pressed.
            onMouseDown={(event) => event.preventDefault()}
        >
            {SLASH_GROUPS.map((group) => {
                const rows = entries.flatMap((entry, index) => (entry.group === group ? [{ entry, index }] : []));
                if (rows.length === 0) return null;
                return (
                    <Fragment key={group}>
                        <div className="menu-label slash-group" role="presentation">{SLASH_GROUP_TITLES[group]}</div>
                        {rows.map(({ entry, index }) => {
                            const unsupported = entry.action.kind === "unsupported";
                            const extra = hint(entry);
                            return (
                                <div
                                    key={`${entry.group}-${entry.name}`}
                                    id={slashOptionId(entry)}
                                    role="option"
                                    className="menu-item slash-item"
                                    aria-selected={index === active}
                                    aria-disabled={unsupported}
                                    data-focused={index === active}
                                    data-unsupported={unsupported}
                                    onMouseMove={() => {
                                        if (index !== active) view.onHover(index);
                                    }}
                                    onClick={() => view.onPick(entry)}
                                >
                                    <span className="slash-name">/{entry.name}</span>
                                    {extra.length === 0 ? null : <span className="slash-hint">{extra}</span>}
                                    <span className="slash-description">{entry.description}</span>
                                    {unsupported ? <span className="slash-tag">{NOT_IMPLEMENTED}</span> : null}
                                </div>
                            );
                        })}
                    </Fragment>
                );
            })}
        </div>
    );
}
