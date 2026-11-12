import { useCallback, useEffect, useState } from "react";

import { WarningIcon } from "../../components/Icons.tsx";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { parseModelSettings, type ModelSettings } from "../../models/settings.ts";
import { ProviderRow } from "./ProviderRow.tsx";
import { ProviderWizard } from "./ProviderWizard.tsx";
import { SettingRow } from "./SettingRow.tsx";

const UNREADABLE = "The host did not list its models.";

type LoadState =
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly reason: string }
    | { readonly status: "ready"; readonly settings: ModelSettings };

// Settings > Providers: the home's connected providers, read from the host and changed through it.
export function ProvidersSection() {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const [token, setToken] = useState(0);
    const [adding, setAdding] = useState(false);
    const closeWizard = useCallback(() => setAdding(false), []);

    useEffect(() => {
        if (bridge === undefined) return;
        let live = true;
        void bridge.readModelSettings().then(
            (result) => {
                if (!live) return;
                if (!result.ok) {
                    setState({ status: "failed", reason: result.reason });
                    return;
                }
                const parsed = parseModelSettings(result.settings);
                setState(parsed === undefined ? { status: "failed", reason: UNREADABLE } : { status: "ready", settings: parsed });
            },
            () => {
                if (live) setState({ status: "failed", reason: UNREADABLE });
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, token]);

    const retry = () => {
        setState({ status: "loading" });
        setToken((value) => value + 1);
    };

    return (
        <>
            <h1>Providers &amp; models</h1>
            <p className="provider-lede">The providers this Vera home is connected to and the models each one lists.</p>
            {bridge === undefined ? <p className="provider-empty">This window has no host bridge.</p> : null}
            {bridge !== undefined && state.status === "loading" ? <p className="provider-empty">Reading providers…</p> : null}
            {state.status === "failed" ? (
                <div className="provider-failure">
                    <WarningIcon className="provider-failure-icon" />
                    <span>{state.reason}</span>
                    <button type="button" className="button" onClick={retry}>Try again</button>
                </div>
            ) : null}
            {state.status === "ready" && bridge !== undefined ? (
                <>
                    {(state.settings.providers ?? []).length === 0 ? (
                        <p className="provider-empty">
                            No providers are connected. Run <code>vera</code> in a terminal and use <code>/provider</code> to connect one.
                        </p>
                    ) : null}
                    {(state.settings.providers ?? []).map((provider) => (
                        <ProviderRow
                            key={provider.id}
                            bridge={bridge}
                            settings={state.settings}
                            provider={provider}
                            onSettings={(settings) => setState({ status: "ready", settings })}
                            onReload={() => setToken((value) => value + 1)}
                        />
                    ))}
                </>
            ) : null}
            <div className="provider-add">
                <button type="button" className="button" onClick={() => setAdding(true)}>Add a provider</button>
            </div>
            <h2 className="provider-section-head">Fallback</h2>
            <SettingRow name="Fall back after failures" description="Not available in this window yet." />
            {adding ? <ProviderWizard onClose={closeWizard} /> : null}
        </>
    );
}
