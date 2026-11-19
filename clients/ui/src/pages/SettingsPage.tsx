import { Fragment, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { SearchIcon } from "../components/Icons.tsx";
import { AgentsSection } from "./settings/AgentsSection.tsx";
import { AppearanceSection } from "./settings/AppearanceSection.tsx";
import { DataSection } from "./settings/DataSection.tsx";
import { ApprovalsSection } from "./settings/ApprovalsSection.tsx";
import { DevicesSection } from "./settings/DevicesSection.tsx";
import { GitSection } from "./settings/GitSection.tsx";
import { KeyboardSection } from "./settings/KeyboardSection.tsx";
import { ModelsSection } from "./settings/ModelsSection.tsx";
import { ProvidersSection } from "./settings/ProvidersSection.tsx";
import { ShowSection } from "./settings/ShowSection.tsx";
import { filterSettings } from "./settings/filter.ts";
import { focusAndSelectSettingsSearch, subscribeSettingsSearchFocus, takeSettingsSearchFocus } from "./settings/focusSearch.ts";
import { subscribeRequestedSection, takeRequestedSection } from "./settings/requestedSection.ts";
import { SETTINGS_SECTIONS } from "./settings/sections.ts";
import { UpdatesSection } from "./settings/UpdatesSection.tsx";
import { useNarrowRail } from "./settings/useNarrowRail.ts";
import { WorkspacesSection } from "./settings/WorkspacesSection.tsx";

// Settings: a rail of sections beside the chosen one. The rail search hides sections that do not match.
// A narrow page keeps only the rail's icons; its search icon opens the whole rail over the section.
export function SettingsPage() {
    const split = useRef<HTMLDivElement>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const focusSearch = useRef(false);
    const narrow = useNarrowRail(split);
    const [searching, setSearching] = useState(false);
    const [query, setQuery] = useState("");
    const [activeMatch, setActiveMatch] = useState(-1);
    const [selected, setSelected] = useState(SETTINGS_SECTIONS[0]?.id ?? "");
    const icons = narrow && !searching;
    const matches = icons ? SETTINGS_SECTIONS : filterSettings(SETTINGS_SECTIONS, query);
    const current = SETTINGS_SECTIONS.find((section) => section.id === selected) ?? SETTINGS_SECTIONS[0];
    const rail = !narrow ? "full" : searching ? "open" : "icons";

    useEffect(() => {
        if (!narrow) setSearching(false);
    }, [narrow]);

    useEffect(() => {
        const focus = (): void => {
            if (!takeSettingsSearchFocus()) return;
            focusSearch.current = true;
            if (narrow) setSearching(true);
            else {
                focusSearch.current = false;
                if (searchInput.current !== null) focusAndSelectSettingsSearch(searchInput.current);
            }
        };
        return subscribeSettingsSearchFocus(focus);
    }, [narrow]);

    useEffect(() => {
        if (!focusSearch.current || (narrow && !searching)) return;
        focusSearch.current = false;
        if (searchInput.current !== null) focusAndSelectSettingsSearch(searchInput.current);
    }, [narrow, searching]);

    // A section asked for by name, such as the one the Help chat shows.
    useEffect(() => {
        const apply = (): void => {
            const id = takeRequestedSection();
            if (id === undefined || !SETTINGS_SECTIONS.some((section) => section.id === id)) return;
            setSelected(id);
            setQuery("");
        };
        apply();
        return subscribeRequestedSection(apply);
    }, []);

    // The icon rail lists every section, so a closed search keeps no hidden query.
    const closeSearch = (): void => {
        setSearching(false);
        setQuery("");
        setActiveMatch(-1);
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
        if (event.key === "Escape" && searching) {
            event.stopPropagation();
            closeSearch();
            return;
        }
        if (event.target !== searchInput.current || matches.length === 0) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveMatch((current) => current < 0 ? (direction === 1 ? 0 : matches.length - 1) : (current + direction + matches.length) % matches.length);
        } else if (event.key === "Enter") {
            event.preventDefault();
            const match = matches[activeMatch < 0 ? 0 : activeMatch];
            if (match !== undefined) pick(match.id);
        }
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
                            ref={searchInput}
                            value={query}
                            autoFocus={searching}
                            onChange={(event) => { setQuery(event.target.value); setActiveMatch(-1); }}
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
                            data-active={index === activeMatch ? "true" : undefined}
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
                    {current?.id === "appearance" ? <AppearanceSection /> : null}
                    {current?.id === "agents" ? <AgentsSection /> : null}
                    {current?.id === "approvals" ? <ApprovalsSection /> : null}
                    {current?.id === "providers" ? <ProvidersSection /> : null}
                    {current?.id === "models" ? <ModelsSection onProviders={() => pick("providers")} /> : null}
                    {current?.id === "workspaces" ? <WorkspacesSection /> : null}
                    {current?.id === "git" ? <GitSection /> : null}
                    {current?.id === "devices" ? <DevicesSection /> : null}
                    {current?.id === "keyboard" ? <KeyboardSection /> : null}
                    {current?.id === "updates" ? <UpdatesSection /> : null}
                    {current?.id === "show" ? <ShowSection /> : null}
                    {current?.id === "data" ? <DataSection /> : null}
                </div>
            </div>
        </div>
    );
}
