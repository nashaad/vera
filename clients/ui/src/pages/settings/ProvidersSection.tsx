import { useCallback, useEffect, useState } from "react";

import "../../styles/provider-cards.css";
import { WarningIcon } from "../../components/Icons.tsx";
import type { ModelSettings } from "../../models/settings.ts";
import type { DesktopBridge, ProviderStatus } from "../../protocol/bridge.ts";
import { parseModelSettings } from "../../models/settings.ts";
import { ProviderCards } from "./ProviderCards.tsx";
import { ProviderWizard } from "./ProviderWizard.tsx";
import { SettingRow } from "./SettingRow.tsx";

const UNREADABLE = "The host did not list its models.";

interface ReadyState {
    readonly settings: ModelSettings;
    readonly providers: readonly ProviderStatus[];
}

type LoadState =
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly reason: string }
    | { readonly status: "ready"; readonly data: ReadyState };

export function ProvidersSection() {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const [token, setToken] = useState(0);
    const [wizard, setWizard] = useState<{ readonly provider?: string; readonly custom: boolean; readonly replace: boolean } | undefined>();

    useEffect(() => {
        if (bridge === undefined) return;
        let live = true;
        void Promise.all([bridge.readModelSettings(), bridge.listProviders()]).then(
            ([modelResult, providerResult]) => {
                if (!live) return;
                if (!modelResult.ok) {
                    setState({ status: "failed", reason: modelResult.reason });
                    return;
                }
                if (!providerResult.ok) {
                    setState({ status: "failed", reason: providerResult.reason });
                    return;
                }
                const settings = parseModelSettings(modelResult.settings);
                if (settings === undefined) {
                    setState({ status: "failed", reason: UNREADABLE });
                    return;
                }
                const providers = providerResult.providers;
                setState({ status: "ready", data: { settings, providers } });
            },
            () => {
                if (live) setState({ status: "failed", reason: UNREADABLE });
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, token]);

    const reload = useCallback(() => {
        setState({ status: "loading" });
        setToken((value) => value + 1);
    }, []);
    const closeWizard = useCallback(() => {
        setWizard(undefined);
        reload();
    }, [reload]);

    return (
        <>
            <h1>Providers</h1>
            {bridge === undefined ? <p className="provider-empty">This window has no host bridge.</p> : null}
            {bridge !== undefined && state.status === "loading" ? <p className="provider-empty">Reading providers…</p> : null}
            {state.status === "failed" ? (
                <div className="provider-failure">
                    <WarningIcon className="provider-failure-icon" />
                    <span>{state.reason}</span>
                    <button type="button" className="button" onClick={reload}>Try again</button>
                </div>
            ) : null}
            {state.status === "ready" && bridge !== undefined ? (
                <ProviderCards
                    bridge={bridge}
                    providers={state.data.providers}
                    runningProvider={state.data.settings.provider}
                    onConnect={(provider) => setWizard({ provider: provider.id, custom: false, replace: false })}
                    onCustom={() => setWizard({ custom: true, replace: false })}
                    onReload={reload}
                />
            ) : null}
            <h2 className="settings-sec">Fallback</h2>
            <SettingRow name="Fall back after failures" description="Not available in this window." />
            {wizard !== undefined ? (
                <ProviderWizard
                    onClose={closeWizard}
                    {...(wizard.provider === undefined ? {} : { initialProvider: wizard.provider })}
                    initialCustom={wizard.custom}
                    initialReplace={wizard.replace}
                />
            ) : null}
        </>
    );
}
