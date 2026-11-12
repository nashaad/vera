import { useState } from "react";

import { LayersIcon, RefreshIcon, WarningIcon } from "../../components/Icons.tsx";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { parseModelSettings, type ModelSettings, type ProviderCatalog } from "../../models/settings.ts";
import { providerDescription } from "./providers.ts";

const UNREADABLE = "The host did not list its models.";

interface ProviderRowProps {
    readonly bridge: DesktopBridge;
    readonly settings: ModelSettings;
    readonly provider: ProviderCatalog;
    readonly onSettings: (settings: ModelSettings) => void;
    readonly onReload: () => void;
}

type Busy = "refresh" | "forget" | undefined;

export function ProviderRow({ bridge, settings, provider, onSettings, onReload }: ProviderRowProps) {
    const [busy, setBusy] = useState<Busy>(undefined);
    const [confirming, setConfirming] = useState(false);
    const [failure, setFailure] = useState<string | undefined>(undefined);
    const running = settings.provider === provider.id;

    const refresh = () => {
        setBusy("refresh");
        setFailure(undefined);
        void bridge.refreshCatalog(provider.id).then(
            (result) => {
                setBusy(undefined);
                if (!result.ok) {
                    setFailure(result.reason);
                    return;
                }
                const parsed = parseModelSettings(result.settings);
                if (parsed === undefined) setFailure(UNREADABLE);
                else onSettings(parsed);
            },
            () => {
                setBusy(undefined);
                setFailure(UNREADABLE);
            },
        );
    };

    const forget = () => {
        setBusy("forget");
        setConfirming(false);
        setFailure(undefined);
        void bridge.forgetProvider(provider.id).then(
            (result) => {
                setBusy(undefined);
                if (!result.ok) setFailure(result.reason);
                else onReload();
            },
            () => {
                setBusy(undefined);
                setFailure(UNREADABLE);
            },
        );
    };

    return (
        <div className="provider-row">
            <LayersIcon className="provider-icon" />
            <div className="provider-body">
                <div className="provider-name">
                    {provider.label}
                    {running ? <span className="provider-badge">Running</span> : null}
                </div>
                <div className="provider-desc">{providerDescription(settings, provider, Date.now())}</div>
                {failure === undefined ? null : (
                    <div className="provider-failure">
                        <WarningIcon className="provider-failure-icon" />
                        <span>{failure}</span>
                    </div>
                )}
                {confirming ? (
                    <div className="provider-confirm">
                        <span>
                            Forget {provider.label}? Vera removes its saved connection and what it learned about its models.
                        </span>
                        <div className="provider-actions">
                            <button type="button" className="button provider-danger" onClick={forget}>Forget</button>
                            <button type="button" className="button" onClick={() => setConfirming(false)}>Cancel</button>
                        </div>
                    </div>
                ) : null}
            </div>
            {confirming ? null : (
                <div className="provider-actions">
                    <button type="button" className="button" onClick={refresh} disabled={busy !== undefined}>
                        <RefreshIcon className="provider-button-icon" />
                        {busy === "refresh" ? "Refreshing…" : "Refresh"}
                    </button>
                    <button
                        type="button"
                        className="button"
                        onClick={() => setConfirming(true)}
                        disabled={busy !== undefined}
                    >
                        Forget
                    </button>
                </div>
            )}
        </div>
    );
}
