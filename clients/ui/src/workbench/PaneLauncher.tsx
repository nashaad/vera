import { useCallback, useRef, useState, type KeyboardEvent } from "react";

import { isAnnexPath, resolveAddress } from "../browser/address.ts";
import { openAnnexAddress } from "../browser/annex-address.ts";
import { openAddressInTab, BROWSER_CONTAINER } from "../browser/open.ts";
import { typedAddress } from "../browser/url.ts";
import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { PlusIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { useMenuDismiss } from "../composer/useMenuDismiss.ts";
import { canOpenTab, findContainer, type ResolvedContainer } from "../layout/resolve.ts";
import { usePageLinks } from "../pagepane/PageLinks.tsx";
import { GENERIC_PAGE_KIND } from "../pagepane/kinds.ts";
import { paneEntry } from "../registry/core.ts";
import { ContainerIcon } from "./ContainerIcon.tsx";
import { useWorkbench } from "./context.tsx";
import { containerShortcutKeys } from "./hints.ts";

type Row =
    | { readonly kind: "address"; readonly address: string; readonly container: ResolvedContainer }
    | { readonly kind: "container"; readonly container: ResolvedContainer };

// The "+" in the right pane's top row. Its popover lists the kinds of tab, and a typed web address
// comes first as a Browser tab. Every pick opens a new tab.
export function PaneLauncher() {
    const workbench = useWorkbench();
    const { layout, dispatch, run } = workbench;
    const { annex } = usePageLinks();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [focus, setFocus] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);

    const platform = window.veraDesktop?.platform ?? "";
    const needle = query.trim().toLowerCase();
    const browser = findContainer(layout, BROWSER_CONTAINER);
    const annexAddress = annex !== undefined && isAnnexPath(resolveAddress(query, annex.url));
    const address = browser !== undefined && (annexAddress || canOpenTab(layout, BROWSER_CONTAINER)) && typedAddress(query) !== undefined
        ? query.trim()
        : undefined;
    const rows: Row[] = [
        ...(address === undefined || browser === undefined ? [] : [{ kind: "address", address, container: browser } as const]),
        ...layout.locations.rightPane.containers
            .filter((container) => container.id !== GENERIC_PAGE_KIND && paneEntry(container.id, container).title.toLowerCase().includes(needle))
            .map((container) => ({ kind: "container", container }) as const),
    ];
    const current = Math.min(focus, Math.max(0, rows.length - 1));

    const pick = (row: Row): void => {
        setOpen(false);
        if (row.kind === "address") {
            if (!openAnnexAddress(workbench, annex, row.address)) void openAddressInTab(dispatch, row.address);
        }
        else if (!canOpenTab(layout, row.container.id)) return;
        else {
            const { command } = paneEntry(row.container.id, row.container);
            if (command === undefined) run(LAYOUT_COMMANDS.tabOpen, { container: row.container.id });
            else run(command);
        }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            setOpen(false);
            trigger.current?.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (rows.length > 0) setFocus((current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        } else if (event.key === "Enter") {
            event.preventDefault();
            const row = rows[current];
            if (row !== undefined) pick(row);
        }
    };

    return (
        <div className="pane-launcher" ref={root}>
            <button
                ref={trigger}
                type="button"
                className="header-button"
                aria-label="New tab"
                title="New tab"
                aria-haspopup="listbox"
                aria-expanded={open}
                data-pane-launcher
                onClick={() => {
                    setQuery("");
                    setFocus(0);
                    setOpen(!open);
                }}
            >
                <PlusIcon />
            </button>
            {open ? (
                <div className="pane-launcher-menu menu" role="listbox" aria-label="New tab" data-popover="below-start" style={placed} onKeyDown={onKeyDown}>
                    <label className="model-search">
                        <input
                            autoFocus
                            placeholder="Search panes or enter an address"
                            aria-label="Search panes"
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setFocus(0);
                            }}
                        />
                    </label>
                    {rows.map((row, index) => {
                        const keys = row.kind === "address" ? [] : containerShortcutKeys(row.container.id, platform);
                        const disabled = row.kind === "container" && !canOpenTab(layout, row.container.id);
                        const entry = paneEntry(row.container.id, row.container);
                        return (
                            <button
                                key={row.kind === "address" ? "address" : row.container.id}
                                type="button"
                                role="option"
                                aria-selected={index === current}
                                aria-disabled={disabled}
                                className="menu-item pane-launcher-row"
                                data-focused={index === current}
                                data-pane-option={row.kind === "address" ? "address" : row.container.id}
                                onMouseMove={() => setFocus(index)}
                                onClick={() => pick(row)}
                            >
                                <ContainerIcon name={entry.icon} />
                                <span className="pane-launcher-title">{row.kind === "address" ? `Open ${row.address}` : entry.title}</span>
                                {keys.map((key) => <kbd key={key} className="kbd">{key}</kbd>)}
                            </button>
                        );
                    })}
                    {rows.length === 0 ? <p className="model-empty">No pane matches</p> : null}
                </div>
            ) : null}
        </div>
    );
}
