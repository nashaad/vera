import { Fragment, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { SearchIcon } from "../components/Icons.tsx";
import { AgentsSection } from "./settings/AgentsSection.tsx";
import { BrowserSection } from "./settings/BrowserSection.tsx";
import { AppearanceSection } from "./settings/AppearanceSection.tsx";
import { DataSection } from "./settings/DataSection.tsx";
import { ApprovalsSection } from "./settings/ApprovalsSection.tsx";
import { DevicesSection } from "./settings/DevicesSection.tsx";
import { GitSection } from "./settings/GitSection.tsx";
import { KeyboardSection } from "./settings/KeyboardSection.tsx";
import { ModelsSection } from "./settings/ModelsSection.tsx";
import { ProvidersSection } from "./settings/ProvidersSection.tsx";
import { RowHighlightContext, useRowHighlight } from "./settings/RowHighlight.tsx";
import { ShowSection } from "./settings/ShowSection.tsx";
import { focusAndSelectSearch, settingsSearchFocus } from "./focusSearch.ts";
import { subscribeRequestedSection, takeRequestedSection } from "./settings/requestedSection.ts";
import { nextActiveIndex, searchSettings, type SettingsSearchHit } from "./settings/rows.ts";
import { SETTINGS_SECTIONS } from "./settings/sections.ts";
import { UpdatesSection } from "./settings/UpdatesSection.tsx";
import { useNarrowRail } from "./settings/useNarrowRail.ts";
import { WorkspacesSection } from "./settings/WorkspacesSection.tsx";

// Settings: a rail of sections beside the chosen one. The search lists matching settings and sections under the box;
// the rail itself always lists every section. A narrow page keeps only the rail's icons; its search icon opens the rail.
export function SettingsPage() {
    const split = useRef<HTMLDivElement>(null);
    const main = useRef<HTMLDivElement>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const focusSearch = useRef(false);
    const narrow = useNarrowRail(split);
    const highlight = useRowHighlight(main);
    const [searching, setSearching] = useState(false);
    const [query, setQuery] = useState("");
    const [activeMatch, setActiveMatch] = useState(-1);
    const [selected, setSelected] = useState(SETTINGS_SECTIONS[0]?.id ?? "");
    const icons = narrow && !searching;
    const current = SETTINGS_SECTIONS.find((section) => section.id === selected) ?? SETTINGS_SECTIONS[0];
    const rail = !narrow ? "full" : searching ? "open" : "icons";
    const results = searchSettings(query);
    const resultsOpen = query.trim() !== "";

    useEffect(() => {
        if (!narrow) setSearching(false);
    }, [narrow]);

    useEffect(() => {
        const focus = (): void => {
            if (!settingsSearchFocus.take()) return;
            focusSearch.current = true;
            if (narrow) setSearching(true);
            else {
                focusSearch.current = false;
                if (searchInput.current !== null) focusAndSelectSearch(searchInput.current);
            }
        };
        return settingsSearchFocus.subscribe(focus);
    }, [narrow]);

    useEffect(() => {
        if (!focusSearch.current || (narrow && !searching)) return;
        focusSearch.current = false;
        if (searchInput.current !== null) focusAndSelectSearch(searchInput.current);
    }, [narrow, searching]);

    // A section asked for by name, such as the one the Help chat shows.
    useEffect(() => {
        const apply = (): void => {
            const id = takeRequestedSection();
            if (id === undefined || !SETTINGS_SECTIONS.some((section) => section.id === id)) return;
            setSelected(id);
            setQuery("");
            highlight.clear();
        };
        apply();
        return subscribeRequestedSection(apply);
    }, [highlight.clear]);

    const closeSearch = (): void => {
        setSearching(false);
        setQuery("");
        setActiveMatch(-1);
    };
    const pick = (id: string): void => {
        setSelected(id);
        setQuery("");
        setActiveMatch(-1);
        if (searching) setSearching(false);
        highlight.clear();
    };
    const pickResult = (hit: SettingsSearchHit): void => {
        pick(hit.sectionId);
        if (hit.kind === "row") highlight.show(hit.rowId);
    };
    const leave = (event: FocusEvent<HTMLElement>): void => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        closeSearch();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
        if (event.key === "Escape" && (searching || resultsOpen)) {
            event.stopPropagation();
            closeSearch();
            return;
        }
        if (event.target !== searchInput.current || !resultsOpen || results.length === 0) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveMatch((current) => nextActiveIndex(current, results.length, direction));
        } else if (event.key === "Enter") {
            event.preventDefault();
            const hit = results[activeMatch >= 0 && activeMatch < results.length ? activeMatch : 0];
            if (hit !== undefined) pickResult(hit);
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
                    <div className="rail-search-slot">
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
                        {resultsOpen ? (
                            <div className="rail-results" role="listbox" aria-label="Search results" data-settings-results="">
                                {results.length === 0 ? <p className="rail-empty">No settings match</p> : results.map((hit, index) => {
                                    const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === hit.sectionId);
                                    if (section === undefined) return null;
                                    return (
                                        <button
                                            key={hit.kind === "row" ? hit.rowId : `section:${hit.sectionId}`}
                                            type="button"
                                            role="option"
                                            className="rail-result"
                                            aria-selected={index === activeMatch}
                                            data-kind={hit.kind}
                                            data-active={index === activeMatch ? "true" : undefined}
                                            onMouseDown={(event) => event.preventDefault()}
                                            onClick={() => pickResult(hit)}
                                        >
                                            {hit.kind === "row" ? <section.Icon className="rail-icon" /> : null}
                                            <span className="rail-result-body">
                                                <span className="rail-result-name">{hit.name}</span>
                                                {hit.kind === "row" ? <span className="rail-result-section">{section.name}</span> : null}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                )}
                {SETTINGS_SECTIONS.map((section, index) => (
                    <Fragment key={section.id}>
                        {SETTINGS_SECTIONS[index - 1]?.group !== section.group ? <div className="rail-group">{section.group}</div> : null}
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
            </nav>
            <RowHighlightContext.Provider value={highlight}>
                <div className="settings-main" ref={main}>
                    <div className="settings-col">
                        {current?.id === "browser" ? <BrowserSection /> : null}
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
            </RowHighlightContext.Provider>
        </div>
    );
}
