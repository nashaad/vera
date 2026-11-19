import { useEffect, useMemo, useRef, useState } from "react";

import { RefreshIcon, SearchIcon } from "../../components/Icons.tsx";
import { parseModelSettings, type ModelEntry, type ModelSettings } from "../../models/settings.ts";
import type { DesktopBridge, ProviderStatus } from "../../protocol/bridge.ts";
import "../../styles/provider-cards.css";
import "../../styles/model-settings-section.css";

interface ModelsSectionProps {
    readonly onProviders: () => void;
}

interface LoadedModels {
    readonly settings: ModelSettings;
    readonly providers: readonly ProviderStatus[];
}

export const MODELS_FIRST_PAGE = 12;
export const MODELS_PAGE_SIZE = 50;

export function modelRows(settings: ModelSettings, providers: readonly ProviderStatus[], search: string): readonly ModelEntry[] {
    const ids = new Set(providers.filter((provider) => provider.connected).map((provider) => provider.id));
    const all = new Map<string, ModelEntry>();
    for (const entry of settings.shortlist) if (ids.has(entry.provider)) all.set(`${entry.provider}/${entry.model}`, entry);
    for (const entry of settings.catalog) {
        const key = `${entry.provider}/${entry.model}`;
        if (ids.has(entry.provider) && !all.has(key)) all.set(key, entry);
    }
    const ordered: ModelEntry[] = [];
    const seen = new Set<string>();
    for (const entry of settings.shortlist) {
        const key = `${entry.provider}/${entry.model}`;
        const found = all.get(key);
        if (found !== undefined && !seen.has(key)) {
            seen.add(key);
            ordered.push(found);
        }
    }
    for (const [key, entry] of all) {
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push(entry);
    }
    const normalized = search.trim().toLocaleLowerCase();
    const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
    return normalized === "" ? ordered : ordered.filter((entry) => {
        const provider = providerNames.get(entry.provider) ?? entry.provider;
        return `${entry.label} ${entry.model} ${provider}`.toLocaleLowerCase().includes(normalized);
    });
}

export function ModelsEmptyState({ onProviders }: ModelsSectionProps) {
    return <p className="model-settings-empty"><button type="button" onClick={onProviders}>Connect a provider</button> to choose its models.</p>;
}

export function ModelsSection({ onProviders }: ModelsSectionProps) {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    const [data, setData] = useState<LoadedModels | undefined>();
    const [failure, setFailure] = useState<string | undefined>();
    const [query, setQuery] = useState("");
    const [limit, setLimit] = useState(MODELS_FIRST_PAGE);
    const [refreshing, setRefreshing] = useState(false);
    const [busyModel, setBusyModel] = useState<string | undefined>();
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        if (bridge === undefined) return;
        let live = true;
        void Promise.all([bridge.readModelSettings(), bridge.listProviders()]).then(
            ([settingsResult, providersResult]) => {
                if (!live) return;
                if (!settingsResult.ok) {
                    setFailure(settingsResult.reason);
                    return;
                }
                if (!providersResult.ok) {
                    setFailure(providersResult.reason);
                    return;
                }
                const settings = parseModelSettings(settingsResult.settings);
                if (settings === undefined) {
                    setFailure("The host did not list its models.");
                    return;
                }
                setData({ settings, providers: providersResult.providers.filter((provider) => provider.connected) });
            },
            () => { if (live) setFailure("The host did not list its models."); },
        );
        return () => { live = false; mounted.current = false; };
    }, [bridge]);

    const connected = data?.providers ?? [];
    const rows = useMemo(() => data === undefined ? [] : modelRows(data.settings, connected, query), [connected, data, query]);

    const updateSettings = (settings: ModelSettings): void => {
        setData((current) => current === undefined ? current : { ...current, settings });
    };

    const refresh = async (): Promise<void> => {
        if (bridge === undefined || data === undefined || refreshing || busyModel !== undefined) return;
        const targets = connected.filter((provider) => data.settings.refreshableProviders?.includes(provider.id) === true);
        if (targets.length === 0) return;
        setRefreshing(true);
        setFailure(undefined);
        try {
            for (const provider of targets) {
                const result = await bridge.refreshCatalog(provider.id);
                if (!mounted.current) return;
                if (!result.ok) {
                    setFailure(result.reason);
                    continue;
                }
                const parsed = parseModelSettings(result.settings);
                if (parsed === undefined) setFailure("The host did not list its models.");
                else updateSettings(parsed);
            }
        } catch {
            if (mounted.current) setFailure("The host did not list its models.");
        } finally {
            if (mounted.current) setRefreshing(false);
        }
    };

    const keep = async (entry: ModelEntry, enabled: boolean): Promise<void> => {
        if (bridge === undefined || busyModel !== undefined || refreshing) return;
        const key = `${entry.provider}/${entry.model}`;
        setBusyModel(key);
        setFailure(undefined);
        try {
            const result = await bridge.operateModel(enabled ? "keep" : "unkeep", entry.provider, entry.model);
            if (!mounted.current) return;
            if (!result.ok) {
                setFailure(result.reason);
                return;
            }
            const parsed = result.settings === undefined ? undefined : parseModelSettings(result.settings);
            if (parsed !== undefined) updateSettings(parsed);
            else if (data !== undefined) {
                const shortlist = enabled
                    ? [...data.settings.shortlist.filter((item) => item.provider !== entry.provider || item.model !== entry.model), entry]
                    : data.settings.shortlist.filter((item) => item.provider !== entry.provider || item.model !== entry.model);
                updateSettings({ ...data.settings, shortlist });
            }
        } catch {
            if (mounted.current) setFailure("The host did not list its models.");
        } finally {
            if (mounted.current) setBusyModel(undefined);
        }
    };

    const noRefresh = data === undefined || !connected.some((provider) => data.settings.refreshableProviders?.includes(provider.id) === true);
    const shortlist = new Set((data?.settings.shortlist ?? []).map((entry) => `${entry.provider}/${entry.model}`));
    const visible = rows.slice(0, limit);

    return (
        <section className="model-settings-section" aria-label="Models">
            <h1>Models</h1>
            <p className="model-settings-description">Models that are on appear in the model picker.</p>
            <div className="model-settings-card">
                <div className="model-settings-search-row">
                    <label className="model-settings-search">
                        <SearchIcon />
                        <input
                            type="search"
                            placeholder="Search models"
                            aria-label="Search models"
                            value={query}
                            onChange={(event) => { const value = event.currentTarget.value; setQuery(value); setLimit(value.trim() === "" ? MODELS_FIRST_PAGE : MODELS_PAGE_SIZE); }}
                        />
                    </label>
                    <button type="button" className="model-settings-refresh" aria-label="Refresh" title="Refresh" disabled={noRefresh || refreshing || busyModel !== undefined} onClick={() => void refresh()}>
                        <RefreshIcon />
                    </button>
                </div>
                {data !== undefined && connected.length === 0 ? (
                    <ModelsEmptyState onProviders={onProviders} />
                ) : null}
                {failure === undefined ? null : <p className="model-settings-error" role="alert">{failure}</p>}
                {visible.map((entry) => {
                    const provider = connected.find((item) => item.id === entry.provider);
                    const key = `${entry.provider}/${entry.model}`;
                    const kept = shortlist.has(key);
                    const isDefault = data?.settings.provider === entry.provider && data.settings.model === entry.model;
                    return (
                        <div className="model-settings-row" key={key}>
                            <div className="model-settings-label">
                                <span>{entry.label}</span>
                                {isDefault ? <span className="model-settings-default">Default</span> : null}
                                <span className="model-settings-provider">{provider?.name ?? entry.provider}</span>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                className="appearance-switch"
                                aria-label={`Keep ${entry.label}`}
                                aria-checked={kept}
                                disabled={busyModel !== undefined || refreshing}
                                onClick={() => void keep(entry, !kept)}
                            ><span className="appearance-switch-knob" /></button>
                        </div>
                    );
                })}
                {connected.length > 0 && rows.length > MODELS_FIRST_PAGE && limit === MODELS_FIRST_PAGE && query.trim() === "" ? (
                    <button type="button" className="model-settings-link" onClick={() => setLimit(MODELS_PAGE_SIZE)}>View all models</button>
                ) : null}
                {limit >= MODELS_PAGE_SIZE && rows.length > limit ? (
                    <button type="button" className="model-settings-link" onClick={() => setLimit((current) => current + MODELS_PAGE_SIZE)}>Show more</button>
                ) : null}
            </div>
        </section>
    );
}
