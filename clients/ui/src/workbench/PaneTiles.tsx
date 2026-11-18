import { useState, type KeyboardEvent } from "react";
import { pageAt } from "../browser/address.ts";
import { BROWSER_CONTAINER, openAddressInTab } from "../browser/open.ts";
import { openAnnexAddress } from "../browser/annex-address.ts";
import { useRecents, type RecentPage } from "../browser/recents.ts";
import { typedAddress } from "../browser/url.ts";
import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { usePageLinks } from "../pagepane/PageLinks.tsx";
import { canOpenTab } from "../layout/resolve.ts";
import { paneEntry } from "../registry/core.ts";
import { ContainerIcon } from "./ContainerIcon.tsx";
import { useWorkbench } from "./context.tsx";
import { containerShortcutKeys } from "./hints.ts";
import { moveRecentSelection, recentKey, selectedRecent } from "./pane-search.ts";

// What the right pane shows while it has no tab: one tile per kind of tab. A tile opens a new tab.
export function PaneTiles() {
    const workbench = useWorkbench();
    const { layout, run, dispatch } = workbench;
    const { annex } = usePageLinks();
    const recents = useRecents();
    const [query, setQuery] = useState("");
    const [focused, setFocused] = useState(false);
    const [selected, setSelected] = useState<string | undefined>(undefined);
    const platform = window.veraDesktop?.platform ?? "";
    const needle = query.trim().toLowerCase();
    const matches = recents.filter((item) => (item.title.toLowerCase().includes(needle) || item.target.toLowerCase().includes(needle))
        && (item.kind === "browser" ? canOpenTab(layout, BROWSER_CONTAINER) : pageAt(item.target, annex?.pages ?? []) !== undefined));
    const address = canOpenTab(layout, BROWSER_CONTAINER) ? typedAddress(query) : undefined;
    const pick = (item: RecentPage): void => {
        if (openAnnexAddress(workbench, annex, item.target)) return;
        if (item.kind === "browser") void openAddressInTab(dispatch, item.target);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            setFocused(false);
            setSelected(undefined);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setFocused(true);
            setSelected(moveRecentSelection(matches, selected, event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Enter") {
            const item = focused ? selectedRecent(matches, selected) : undefined;
            if (item !== undefined) { event.preventDefault(); pick(item); }
            else if (address !== undefined) {
                event.preventDefault();
                if (!openAnnexAddress(workbench, annex, query)) void openAddressInTab(dispatch, address);
            }
        }
    };
    return (
        <div className="pane-tiles" data-pane-tiles>
            <div className="pane-new-content">
                <div className="pane-new-search">
                    <input
                        aria-label="Search panes"
                        placeholder="Search panes or enter an address"
                        value={query}
                        onFocus={() => setFocused(true)}
                        onClick={() => setFocused(true)}
                        onBlur={() => setFocused(false)}
                        onKeyDown={onKeyDown}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setSelected(undefined);
                            setFocused(true);
                        }}
                    />
                    {focused && matches.length > 0 ? (
                        <div className="pane-new-results menu" role="listbox" aria-label="Recent pages">
                            {matches.map((item) => (
                                <button
                                    key={recentKey(item)}
                                    type="button"
                                    role="option"
                                    aria-selected={selected === recentKey(item)}
                                    data-focused={selected === recentKey(item)}
                                    className="menu-item pane-launcher-row"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onMouseMove={() => setSelected(recentKey(item))}
                                    onClick={() => pick(item)}
                                >
                                    <span className="pane-launcher-title">{item.title}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
                <h3>New</h3>
                <div className="pane-tiles-grid">
                    {layout.locations.rightPane.containers.filter((container) => paneEntry(container.id, container).title.toLowerCase().includes(needle)).map((container) => {
                        const keys = containerShortcutKeys(container.id, platform);
                        const entry = paneEntry(container.id, container);
                        return (
                            <button
                                key={container.id}
                                type="button"
                                className="pane-tile"
                                data-pane-tile={container.id}
                                disabled={!canOpenTab(layout, container.id)}
                                onClick={() => (entry.command === undefined ? run(LAYOUT_COMMANDS.tabOpen, { container: container.id }) : run(entry.command))}
                            >
                                <ContainerIcon name={entry.icon} className="pane-tile-icon" />
                                <span className="pane-tile-title">{entry.title}</span>
                                {keys.length === 0 ? null : (
                                    <span className="pane-tile-keys">
                                        {keys.map((key) => <kbd key={key} className="kbd">{key}</kbd>)}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
