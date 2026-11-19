import type { ProviderStatus } from "../../../protocol/bridge.ts";
import { availableProviderLabel, connectedProviderLabel, customProviderHost } from "../provider-labels.ts";

interface ProviderStepProps {
    readonly providers: readonly ProviderStatus[];
    readonly runningProvider?: string;
    readonly query: string;
    readonly onChoose: (provider: ProviderStatus) => void;
    readonly onCustom: () => void;
}

export function ProviderStep({ providers, runningProvider, query, onChoose, onCustom }: ProviderStepProps) {
    const matches = providers.filter((provider) => provider.name.toLowerCase().includes(query.toLowerCase()));
    const connected = matches.filter((provider) => provider.connected);
    const available = matches.filter((provider) => !provider.connected);
    return (
        <div className="provider-cards provider-wizard-provider-list" role="group" aria-label="Provider">
            {connected.length > 0 ? <section className="provider-card">
                <h2>Connected</h2>
                {connected.map((provider) => (
                    <button type="button" className="provider-card-row provider-wizard-provider-row" key={provider.id} onClick={() => onChoose(provider)}>
                        <span className="provider-card-main">
                            <span className="provider-card-name">{provider.name}</span>
                            <span className="provider-card-label">{connectedProviderLabel(provider)}</span>
                            {provider.id === runningProvider ? <span className="provider-card-label">In use</span> : null}
                            {customProviderHost(provider) ? <span className="provider-card-description">{customProviderHost(provider)}</span> : null}
                        </span>
                    </button>
                ))}
            </section> : null}
            <section className="provider-card">
                <h2>Add a provider</h2>
                {available.map((provider) => (
                    <button type="button" className="provider-card-row provider-wizard-provider-row" key={provider.id} onClick={() => onChoose(provider)}>
                        <span className="provider-card-main">
                            <span className="provider-card-name">{provider.name}</span>
                            <span className="provider-card-label">{availableProviderLabel(provider)}</span>
                        </span>
                    </button>
                ))}
                <button type="button" className="provider-card-row provider-card-custom provider-wizard-custom-row" onClick={onCustom}>
                    <span className="provider-card-main">
                        <span className="provider-card-name">Custom provider</span>
                        <span className="provider-card-label">Custom</span>
                        <span className="provider-card-description">Any OpenAI-compatible endpoint by its base URL.</span>
                    </span>
                </button>
            </section>
        </div>
    );
}
