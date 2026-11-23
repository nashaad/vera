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
                <p className="provider-card-description">Turn a provider off to keep its setup and stop new use. Sessions already running on its models finish.</p>
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

interface ConnectedProviderRowViewProps {
    readonly provider: ProviderStatus;
    readonly inUse: boolean;
    readonly busy: boolean;
    readonly confirming: boolean;
    readonly failure?: string;
    readonly notice?: string;
    readonly onOpen: () => void;
    readonly onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
    readonly onForget: (event: MouseEvent<HTMLButtonElement>) => void;
    readonly onConfirmForget: (event: MouseEvent<HTMLButtonElement>) => void;
    readonly onCancel: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function ConnectedProviderRowView({
    provider,
    inUse,
    busy,
    confirming,
    failure,
    notice,
    onOpen,
    onToggle,
    onForget,
    onConfirmForget,
    onCancel,
}: ConnectedProviderRowViewProps) {
    return (
        <div
            className="provider-card-entry"
            role="group"
            aria-label={provider.name}
            tabIndex={0}
            onClick={() => { if (!confirming) onOpen(); }}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (!confirming) onOpen();
                }
            }}
        >
            <div className="provider-card-row provider-card-connected-row">
                <span className="provider-card-main">
                    <span className="provider-card-name">{provider.name}</span>
                    <span className="provider-card-label">{connectedProviderLabel(provider)}</span>
                    {provider.enabled ? null : <span className="provider-card-label">Off</span>}
                    {inUse ? <span className="provider-card-label">In use</span> : null}
                    {customProviderHost(provider) ? <span className="provider-card-description">{customProviderHost(provider)}</span> : null}
                </span>
                <button type="button" className="button" disabled={busy} onClick={onToggle}>{provider.enabled ? "Turn off" : "Turn on"}</button>
                <button type="button" className="button" disabled={busy} onClick={onForget}>Forget</button>
            </div>
            {confirming ? (
                <ProviderForgetConfirmation
                    name={provider.name}
                    busy={busy}
                    onForget={onConfirmForget}
                    onCancel={onCancel}
                />
            ) : null}
            {failure === undefined ? null : <p role="alert">{failure}</p>}
            {notice === undefined ? null : <p role="status">{notice}</p>}
        </div>
    );
}

export function providerEnabledNotice(enabled: boolean, warning: string | undefined): string | undefined {
    return enabled ? warning : undefined;
}

function ConnectedProviderRow({ bridge, provider, inUse, onConnect, onReload }: ConnectedProviderRowProps) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string>();
    const [notice, setNotice] = useState<string>();

    function clearStatus(): void {
        setFailure(undefined);
        setNotice(undefined);
    }

    async function setEnabled(enabled: boolean): Promise<void> {
        setBusy(true);
        clearStatus();
        try {
            const result = await bridge.setProviderEnabled(provider.id, enabled);
            if (!result.ok) {
                setFailure(result.reason);
                return;
            }
            const notice = providerEnabledNotice(enabled, result.warning);
            if (notice !== undefined) {
                setNotice(notice);
            }
            onReload();
        } catch {
            setFailure("The host is not connected.");
        } finally {
            setBusy(false);
        }
    }

    async function forget(): Promise<void> {
        setBusy(true);
        clearStatus();
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
        <ConnectedProviderRowView
            provider={provider}
            inUse={inUse}
            busy={busy}
            confirming={confirming}
            {...(failure === undefined ? {} : { failure })}
            {...(notice === undefined ? {} : { notice })}
            onOpen={() => { clearStatus(); onConnect(); }}
            onToggle={(event) => { event.stopPropagation(); void setEnabled(!provider.enabled); }}
            onForget={(event) => { event.stopPropagation(); clearStatus(); setConfirming(true); }}
            onConfirmForget={(event) => { event.stopPropagation(); void forget(); }}
            onCancel={(event) => { event.stopPropagation(); clearStatus(); setConfirming(false); }}
        />
    );
}
