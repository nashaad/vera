import { useEffect, useMemo, useState } from "react";

import { ChevronDownIcon, LayersIcon, SearchIcon, XIcon } from "../../components/Icons.tsx";
import { INTELLIGENCE_CUTOFFS, allModels, browseRows, type IntelligenceCutoff } from "../catalog.ts";
import type { ModelControls, ProbeOutcome } from "../controls.ts";
import type { ModelEntry } from "../settings.ts";
import { DefaultsTab } from "./DefaultsTab.tsx";
import { HelpTab } from "./HelpTab.tsx";
import { ModelDetail } from "./ModelDetail.tsx";
import { ModelList } from "./ModelList.tsx";
import { providerLabel } from "../menuRows.ts";
import {
    ANY_PROVIDER,
    BROWSER_TABS,
    TAB_NOTES,
    type BrowserTab,
    cutoffLabel,
    entryKey,
    fromProvider,
    pickSelection,
    providerOrder,
    tabRows,
} from "./rows.ts";

export interface ModelsBrowserProps {
    readonly controls: ModelControls;
    readonly onClose: () => void;
}

const NO_FAVORITES = "You have no favorites. Pin a model under All models.";
const NO_MATCH = "No model clears that filter.";

interface ProbeResult {
    readonly key: string;
    readonly outcome: ProbeOutcome;
}

export function ModelsBrowser({ controls, onClose }: ModelsBrowserProps) {
    const [tab, setTab] = useState<BrowserTab>("All models");
    const [query, setQuery] = useState("");
    const [cutoff, setCutoff] = useState<IntelligenceCutoff>("any");
    const [provider, setProvider] = useState<string>(ANY_PROVIDER);
    const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
    const [probing, setProbing] = useState<string | undefined>(undefined);
    const [probed, setProbed] = useState<ProbeResult | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const { settings, enabled, choice, actions } = controls;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const everything = useMemo(() => (settings === undefined ? [] : allModels(settings)), [settings]);
    const pinned = useMemo(
        () => new Set((settings?.shortlist ?? []).map(entryKey)),
        [settings],
    );
    const providers = useMemo(() => (settings === undefined ? [] : providerOrder(settings)), [settings]);
    const pool = useMemo(() => (settings === undefined ? [] : tabRows(tab, settings)), [settings, tab]);
    // A provider that left the catalog falls back to Any rather than emptying the list.
    const shownProvider = providers.includes(provider) ? provider : ANY_PROVIDER;
    const rows = useMemo(
        () => browseRows(fromProvider(pool, shownProvider), query, cutoff),
        [pool, shownProvider, query, cutoff],
    );
    const selected = pickSelection(rows, selectedKey, choice);
    const selectedId = selected === undefined ? undefined : entryKey(selected);
    const probeOutcome = probed !== undefined && probed.key === selectedId ? probed.outcome : undefined;

    const pin = async (entry: ModelEntry, on: boolean) => {
        setProblem(undefined);
        const reason = await actions.shortlist({ provider: entry.provider, model: entry.model }, on);
        if (reason !== undefined) setProblem(reason);
    };

    const probe = async (entry: ModelEntry) => {
        const key = entryKey(entry);
        setProbing(key);
        setProbed(undefined);
        const outcome = await actions.probe({ provider: entry.provider, model: entry.model });
        setProbing(undefined);
        setProbed({ key, outcome });
    };

    const pick = (entry: ModelEntry) => {
        actions.pick({ provider: entry.provider, model: entry.model });
        onClose();
    };

    const providerName = (provider: string): string => (settings === undefined ? provider : providerLabel(settings, provider));
    const showsList = tab === "Favorites" || tab === "All models";
    const notes = [problem, controls.note].filter((text): text is string => text !== undefined);

    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="sheet models-sheet" role="dialog" aria-modal="true" aria-label="Models">
                <div className="sheet-head">
                    <LayersIcon className="models-head-icon" />
                    <span className="models-title">Models</span>
                    <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">
                        <XIcon />
                    </button>
                </div>

                <div className="models-tabs" role="tablist">
                    {BROWSER_TABS.map((name) => (
                        <button
                            key={name}
                            type="button"
                            role="tab"
                            className="models-tab"
                            aria-selected={name === tab}
                            data-on={name === tab}
                            onClick={() => setTab(name)}
                        >
                            {name}
                            {name === "Favorites" && settings !== undefined && (
                                <span className="models-tab-count">{settings.shortlist.length}</span>
                            )}
                            {name === "All models" && settings !== undefined && (
                                <span className="models-tab-count">{everything.length}</span>
                            )}
                        </button>
                    ))}
                    <span className="models-tab-note">{TAB_NOTES[tab]}</span>
                </div>

                <div className="sheet-body">
                    {tab === "Help" && <HelpTab />}
                    {tab !== "Help" && settings === undefined && (
                        <div className="models-empty">Vera has not listed its models yet.</div>
                    )}
                    {tab === "Defaults" && settings !== undefined && <DefaultsTab settings={settings} />}
                    {showsList && settings !== undefined && (
                        <>
                            <div className="models-toolbar">
                                <label className="models-search">
                                    <SearchIcon />
                                    <input
                                        type="search"
                                        placeholder="Search models"
                                        value={query}
                                        onChange={(event) => setQuery(event.target.value)}
                                    />
                                </label>
                                <label className="models-cutoff">
                                    Provider
                                    <span className="models-select">
                                        <select value={shownProvider} onChange={(event) => setProvider(event.target.value)}>
                                            <option value={ANY_PROVIDER}>Any</option>
                                            {providers.map((name) => (
                                                <option key={name} value={name}>
                                                    {`${providerName(name)} (${fromProvider(pool, name).length})`}
                                                </option>
                                            ))}
                                        </select>
                                        <ChevronDownIcon className="models-select-chevron" />
                                    </span>
                                </label>
                                <label className="models-cutoff">
                                    Intelligence
                                    <span className="models-select">
                                        <select
                                            value={cutoff}
                                            onChange={(event) => setCutoff(event.target.value as IntelligenceCutoff)}
                                        >
                                            {INTELLIGENCE_CUTOFFS.map((value) => (
                                                <option key={value} value={value}>
                                                    {cutoffLabel(value)}
                                                </option>
                                            ))}
                                        </select>
                                        <ChevronDownIcon className="models-select-chevron" />
                                    </span>
                                </label>
                            </div>
                            <div className="models-split">
                                <ModelList
                                    rows={rows}
                                    empty={tab === "Favorites" && pool.length === 0 ? NO_FAVORITES : NO_MATCH}
                                    selectedKey={selectedId}
                                    choice={choice}
                                    pinned={pinned}
                                    enabled={enabled}
                                    providerName={providerName}
                                    onSelect={(entry) => setSelectedKey(entryKey(entry))}
                                    onPin={(entry, on) => void pin(entry, on)}
                                />
                                <ModelDetail
                                    entry={selected}
                                    pinned={selected !== undefined && pinned.has(entryKey(selected))}
                                    enabled={enabled}
                                    providerName={providerName}
                                    probing={selectedId !== undefined && probing === selectedId}
                                    probeBusy={probing !== undefined}
                                    probeResult={probeOutcome}
                                    onPick={pick}
                                    onPin={(entry, on) => void pin(entry, on)}
                                    onProbe={(entry) => void probe(entry)}
                                />
                            </div>
                        </>
                    )}
                </div>

                {notes.length > 0 && (
                    <div className="sheet-note">
                        {notes.map((text) => (
                            <div key={text}>{text}</div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
