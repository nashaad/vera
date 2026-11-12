import { useState } from "react";

import { SearchIcon } from "../components/Icons.tsx";
import { ApprovalsSection } from "./settings/ApprovalsSection.tsx";
import { ProvidersSection } from "./settings/ProvidersSection.tsx";
import { filterSettings } from "./settings/filter.ts";
import { SETTINGS_SECTIONS } from "./settings/sections.ts";

// Settings: a rail of sections beside the chosen one. The rail search hides sections that do not match.
export function SettingsPage() {
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(SETTINGS_SECTIONS[0]?.id ?? "");
    const matches = filterSettings(SETTINGS_SECTIONS, query);
    const current = SETTINGS_SECTIONS.find((section) => section.id === selected) ?? SETTINGS_SECTIONS[0];

    return (
        <div className="settings-split">
            <nav className="settings-rail" aria-label="Settings">
                <label className="rail-search">
                    <SearchIcon className="rail-search-icon" />
                    <input
                        type="search"
                        placeholder="Search"
                        aria-label="Search settings"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                {matches.length > 0 ? <div className="rail-group">Settings</div> : null}
                {matches.map((section) => (
                    <button
                        key={section.id}
                        type="button"
                        className="rail-row"
                        aria-current={section.id === selected ? "page" : undefined}
                        onClick={() => setSelected(section.id)}
                    >
                        <section.Icon className="rail-icon" />
                        <span>{section.name}</span>
                    </button>
                ))}
                {matches.length === 0 ? <p className="rail-empty">No settings match</p> : null}
            </nav>
            <div className="settings-main">
                <div className="settings-col">
                    {current === undefined ? null : <div className="where">{current.file}</div>}
                    {current?.id === "approvals" ? <ApprovalsSection /> : null}
                    {current?.id === "providers" ? <ProvidersSection /> : null}
                </div>
            </div>
        </div>
    );
}
