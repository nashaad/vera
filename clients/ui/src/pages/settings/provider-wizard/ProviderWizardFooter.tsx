import type { ProviderStatus } from "../../../protocol/bridge.ts";
type ProviderWizardStep = "provider" | "key" | "model";

interface ProviderWizardFooterProps {
    readonly step: ProviderWizardStep;
    readonly provider?: ProviderStatus;
    readonly replacing: boolean;
    readonly busy: boolean;
    readonly id: string;
    readonly apiKey: string;
    readonly model: string;
}

export function ProviderWizardFooter({ step, provider, replacing, busy, id, apiKey, model }: ProviderWizardFooterProps) {
    const browser = provider?.methods.includes("browser") === true;
    const local = provider !== undefined && provider.methods.length === 0;
    const continueExisting = !browser && (provider?.connected === true || local) && !replacing;
    const canConnect = browser || (apiKey.length > 0 && id.trim().length > 0);
    const showKeyAction = step === "key";
    const keyActionDisabled = busy || (!continueExisting && !canConnect);
    const keyActionLabel = busy ? "Connecting…" : continueExisting || local ? "Continue" : browser ? "Sign in" : "Continue";

    return (
        <footer className="provider-wizard-foot">
            {showKeyAction ? <button type="submit" autoFocus={continueExisting || browser} className="button button-primary" disabled={keyActionDisabled}>{keyActionLabel}</button> : null}
            {step === "model" ? <button type="submit" className="button button-primary" disabled={busy || model === ""}>{busy ? "Checking…" : "Check and use"}</button> : null}
        </footer>
    );
}
