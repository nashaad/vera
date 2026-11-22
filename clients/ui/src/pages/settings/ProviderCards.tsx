import { useState, type MouseEvent } from "react";

import type { DesktopBridge, ProviderStatus } from "../../protocol/bridge.ts";
import { availableProviderLabel, connectedProviderLabel, customProviderHost } from "./provider-labels.ts";
import { useSearchHit } from "./RowHighlight.tsx";

interface ProviderCardsProps {
    readonly bridge: DesktopBridge;
    readonly providers: readonly ProviderStatus[];
    readonly runningProvider: string | undefined;
    readonly onConnect: (provider: ProviderStatus) => void;
    readonly onCustom: () => void;
    readonly onReload: () => void;
}

export function ProviderCards({ bridge, providers, runningProvider, onConnect, onCustom, onReload }: ProviderCardsProps) {
    const connected = providers.filter((provider) => provider.connected);
    const available = providers.filter((provider) => !provider.connected);
    const customHit = useSearchHit("providers.custom");

    return (
        <div className="provider-cards">
            <section className="provider-card">
                <h2>Connected</h2>
                {connected.map((provider) => (
                    <ConnectedProviderRow
                        key={provider.id}
                        bridge={bridge}
                        provider={provider}
                        inUse={provider.id === runningProvider}
                        onConnect={() => onConnect(provider)}
                        onReload={onReload}
                    />
                ))}
            </section>
            <section className="provider-card">
                <h2>Add a provider</h2>
                {available.map((provider) => (
                    <button type="button" className="provider-card-row" key={provider.id} onClick={() => onConnect(provider)}>
                        <span className="provider-card-main">
                            <span className="provider-card-name">{provider.name}</span>
                            <span className="provider-card-label">{availableProviderLabel(provider)}</span>
                        </span>
                        <span className="provider-card-action"><span aria-hidden="true">+</span> Connect</span>
                    </button>
                ))}
                <button type="button" className="provider-card-row provider-card-custom" data-setting-id="providers.custom" {...customHit} onClick={onCustom}>
                    <span className="provider-card-main">
                        <span className="provider-card-name">Custom provider</span>
                        <span className="provider-card-label">Custom</span>
                        <span className="provider-card-description">Any OpenAI-compatible endpoint by its base URL.</span>
                    </span>
                    <span className="provider-card-action"><span aria-hidden="true">+</span> Connect</span>
                </button>
            </section>
        </div>
    );
}

interface ProviderForgetConfirmationProps {
    readonly name: string;
    readonly busy: boolean;
    readonly onForget: (event: MouseEvent<HTMLButtonElement>) => void;
    readonly onCancel: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function ProviderForgetConfirmation({ name, busy, onForget, onCancel }: ProviderForgetConfirmationProps) {
    return (
        <div className="provider-card-confirm">
            <span>Forget {name}? Vera removes its saved connection and what it learned about its models.</span>
            <button type="button" className="button" disabled={busy} onClick={onForget}>Forget</button>
            <button type="button" className="button" onClick={onCancel}>Cancel</button>
        </div>
    );
}

interface ConnectedProviderRowProps {
    readonly bridge: DesktopBridge;
    readonly provider: ProviderStatus;
    readonly inUse: boolean;
    readonly onConnect: () => void;
    readonly onReload: () => void;
}

function ConnectedProviderRow({ bridge, provider, inUse, onConnect, onReload }: ConnectedProviderRowProps) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string>();

    async function forget(): Promise<void> {
        setBusy(true);
        setFailure(undefined);
        try {
            const result = await bridge.forgetProvider(provider.id);
            if (!result.ok) {
                setFailure(result.reason);
                return;
            }
            setConfirming(false);
            onReload();
        } catch {
            setFailure("The host is not connected.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            className="provider-card-entry"
            role="group"
            aria-label={provider.name}
            tabIndex={0}
            onClick={() => { if (!confirming) onConnect(); }}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (!confirming) onConnect();
                }
            }}
        >
            <div className="provider-card-row provider-card-connected-row">
                <span className="provider-card-main">
                    <span className="provider-card-name">{provider.name}</span>
                    <span className="provider-card-label">{connectedProviderLabel(provider)}</span>
                    {inUse ? <span className="provider-card-label">In use</span> : null}
                    {customProviderHost(provider) ? <span className="provider-card-description">{customProviderHost(provider)}</span> : null}
                </span>
                <button type="button" className="button" disabled={busy} onClick={(event) => { event.stopPropagation(); setConfirming(true); }}>Forget</button>
            </div>
            {confirming ? (
                <ProviderForgetConfirmation
                    name={provider.name}
                    busy={busy}
                    onForget={(event) => { event.stopPropagation(); void forget(); }}
                    onCancel={(event) => { event.stopPropagation(); setConfirming(false); }}
                />
            ) : null}
            {failure === undefined ? null : <p role="alert">{failure}</p>}
        </div>
    );
}
