import { Fragment, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { SearchIcon } from "../components/Icons.tsx";
import { AgentsSection } from "./settings/AgentsSection.tsx";
import { AppearanceSection } from "./settings/AppearanceSection.tsx";
import { DataSection } from "./settings/DataSection.tsx";
import { ApprovalsSection } from "./settings/ApprovalsSection.tsx";
import { DevicesSection } from "./settings/DevicesSection.tsx";
import { GitSection } from "./settings/GitSection.tsx";
import { KeyboardSection } from "./settings/KeyboardSection.tsx";
import { ProvidersSection } from "./settings/ProvidersSection.tsx";
import { filterSettings } from "./settings/filter.ts";
import { SETTINGS_SECTIONS } from "./settings/sections.ts";
import { useNarrowRail } from "./settings/useNarrowRail.ts";
import { WorkspacesSection } from "./settings/WorkspacesSection.tsx";

// Settings: a rail of sections beside the chosen one. The rail search hides sections that do not match.
// A narrow page keeps only the rail's icons; its search icon opens the whole rail over the section.
export function SettingsPage() {
    const split = useRef<HTMLDivElement>(null);
    const narrow = useNarrowRail(split);
    const [searching, setSearching] = useState(false);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(SETTINGS_SECTIONS[0]?.id ?? "");
    const icons = narrow && !searching;
    const matches = icons ? SETTINGS_SECTIONS : filterSettings(SETTINGS_SECTIONS, query);
    const current = SETTINGS_SECTIONS.find((section) => section.id === selected) ?? SETTINGS_SECTIONS[0];
    const rail = !narrow ? "full" : searching ? "open" : "icons";

    useEffect(() => {
        if (!narrow) setSearching(false);
    }, [narrow]);

    // The icon rail lists every section, so a closed search keeps no hidden query.
    const closeSearch = (): void => {
        setSearching(false);
        setQuery("");
    };
    const pick = (id: string): void => {
        setSelected(id);
        if (searching) closeSearch();
    };
    const leave = (event: FocusEvent<HTMLElement>): void => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        closeSearch();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
        if (event.key !== "Escape" || !searching) return;
        event.stopPropagation();
        closeSearch();
    };

    return (
        <div className="settings-split" ref={split} data-rail={rail}>
            <nav className="settings-rail" aria-label="Settings" onBlur={searching ? leave : undefined} onKeyDown={onKeyDown}>
                {icons ? (
                    <button
                        type="button"
                        className="rail-row"
                        aria-label="Search settings"
                        title="Search settings"
                        onClick={() => setSearching(true)}
                    >
                        <SearchIcon className="rail-icon" />
                    </button>
                ) : (
                    <label className="rail-search">
                        <SearchIcon className="rail-search-icon" />
                        <input
                            type="search"
                            placeholder="Search"
                            aria-label="Search settings"
                            value={query}
                            autoFocus={searching}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                )}
                {matches.map((section, index) => (
                    <Fragment key={section.id}>
                        {matches[index - 1]?.group !== section.group ? <div className="rail-group">{section.group}</div> : null}
                        <button
                            type="button"
                            className="rail-row"
                            aria-current={section.id === selected ? "page" : undefined}
                            {...(icons ? { "aria-label": section.name, title: section.name } : {})}
                            onClick={() => pick(section.id)}
                        >
                            <section.Icon className="rail-icon" />
                            <span>{section.name}</span>
                        </button>
                    </Fragment>
                ))}
                {matches.length === 0 ? <p className="rail-empty">No settings match</p> : null}
            </nav>
            <div className="settings-main">
                <div className="settings-col">
                    {current === undefined ? null : <div className="where">{current.file}</div>}
                    {current?.id === "appearance" ? <AppearanceSection /> : null}
                    {current?.id === "agents" ? <AgentsSection /> : null}
                    {current?.id === "approvals" ? <ApprovalsSection /> : null}
                    {current?.id === "providers" ? <ProvidersSection /> : null}
                    {current?.id === "workspaces" ? <WorkspacesSection /> : null}
                    {current?.id === "git" ? <GitSection /> : null}
                    {current?.id === "devices" ? <DevicesSection /> : null}
                    {current?.id === "keyboard" ? <KeyboardSection /> : null}
                    {current?.id === "data" ? <DataSection /> : null}
                </div>
            </div>
        </div>
    );
}
