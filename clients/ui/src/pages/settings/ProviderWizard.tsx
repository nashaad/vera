import { useEffect, useState } from "react";

import { LayersIcon, XIcon } from "../../components/Icons.tsx";
import { parseModelSettings, type ModelEntry } from "../../models/settings.ts";
import type { DesktopBridge, ProviderStatus } from "../../protocol/bridge.ts";

interface ProviderWizardProps {
    readonly onClose: () => void;
    readonly onComplete?: () => void;
    readonly initialProvider?: string;
}

type Step = "provider" | "key" | "model";

export function ProviderWizard({ onClose, onComplete, initialProvider }: ProviderWizardProps) {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    const [providers, setProviders] = useState<readonly ProviderStatus[]>([]);
    const [step, setStep] = useState<Step>("provider");
    const [selected, setSelected] = useState<ProviderStatus | undefined>();
    const [custom, setCustom] = useState(false);
    const [id, setId] = useState("");
    const [endpoint, setEndpoint] = useState("");
    const [key, setKey] = useState("");
    const [models, setModels] = useState<readonly ModelEntry[]>([]);
    const [model, setModel] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            onClose();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);

    useEffect(() => {
        let live = true;
        if (bridge === undefined) return;
        void bridge.listProviders().then((result) => {
            if (!live) return;
            if (!result.ok) { setError(result.reason); return; }
            setProviders(result.providers);
            const initial = result.providers.find((provider) => provider.id === initialProvider);
            if (initial !== undefined) choose(initial);
        });
        return () => { live = false; bridge.cancelProviderSignIn(); };
    }, [bridge, initialProvider]);

    function choose(provider: ProviderStatus): void {
        setSelected(provider); setCustom(provider.custom); setId(provider.id);
        setEndpoint(provider.endpoint ?? ""); setKey(""); setError(undefined); setStep("key");
    }

    async function loadModels(provider: string): Promise<void> {
        if (bridge === undefined) return;
        const refreshed = await bridge.refreshCatalog(provider);
        if (!refreshed.ok) { setError(refreshed.reason); return; }
        const settings = parseModelSettings(refreshed.settings);
        const rows = (settings?.catalog ?? []).filter((entry) => entry.provider === provider && entry.available);
        setModels(rows); setModel(rows[0]?.model ?? ""); setStep("model");
        if (rows.length === 0) setError("No models were found. Try refreshing the provider.");
    }

    async function connect(): Promise<void> {
        if (bridge === undefined || busy) return;
        setBusy(true); setError(undefined);
        try {
            if (selected?.methods.includes("browser")) {
                const result = await bridge.signInProvider(selected.id);
                if (!result.ok) { setError(result.reason); return; }
                await loadModels(result.provider.id);
            } else {
                const result = await bridge.saveProvider({ provider: id.trim(), key, endpoint: endpoint.trim(),
                    protocol: selected?.protocol ?? "openai-chat", custom,
                    ...(selected?.connected ? { editing: selected.id } : {}) });
                if (!result.ok) { setError(result.reason); return; }
                setSelected(result.provider);
                setKey("");
                await loadModels(result.provider.id);
            }
        } catch { setError("Could not connect the provider."); }
        finally { setBusy(false); }
    }

    async function finish(): Promise<void> {
        if (bridge === undefined || busy || model === "") return;
        setBusy(true); setError(undefined);
        try {
            const result = await bridge.selectProviderModel(id, model);
            if (!result.ok) { setError(result.reason); return; }
            onComplete?.(); onClose();
        } catch { setError("The model did not answer."); }
        finally { setBusy(false); }
    }

    return (
        <div className="wizard-scrim">
            <div className="wizard-sheet" role="dialog" aria-modal="true" aria-label="Connect a provider">
                <header className="wizard-head">
                    <LayersIcon className="wizard-head-icon" />
                    <h2 className="wizard-title">Connect a provider</h2>
                    <button type="button" className="wizard-close" aria-label="Close" onClick={onClose}><XIcon className="wizard-close-icon" /></button>
                </header>
                <ol className="wizard-steps" aria-label="Steps">
                    {["Pick", "Key", "Models"].map((label, index) => <li key={label} className="wizard-step"><span className="wizard-step-index">{index + 1}</span>{label}</li>)}
                </ol>
                <div className="wizard-body">
                    {step === "provider" ? <>
                        <p>Choose a provider.</p>
                        <select aria-label="Provider" value={selected?.id ?? ""} onChange={(event) => {
                            const provider = providers.find((item) => item.id === event.target.value);
                            if (provider !== undefined) choose(provider);
                        }}><option value="">Choose a provider</option>{providers.filter((item) => item.methods.length > 0).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                        <p><button type="button" className="button" onClick={() => { setSelected(undefined); setCustom(true); setId(""); setEndpoint(""); setStep("key"); }}>Add a custom provider</button></p>
                    </> : null}
                    {step === "key" ? <>
                        <p>{selected?.name ?? "Custom provider"}</p>
                        {custom && selected === undefined ? <label>Name <input aria-label="Provider name" value={id} onChange={(event) => setId(event.target.value)} /></label> : null}
                        {!selected?.methods.includes("browser") ? <>
                            <label>Endpoint <input aria-label="Endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
                            <label>API key <input aria-label="API key" type="password" value={key} onChange={(event) => setKey(event.target.value)} /></label>
                        </> : <p>Sign in in your browser.</p>}
                    </> : null}
                    {step === "model" ? <>
                        <p>Choose a model to check and use.</p>
                        <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
                            {models.map((entry) => <option key={entry.model} value={entry.model}>{entry.label}</option>)}
                        </select>
                    </> : null}
                    {error === undefined ? null : <p role="alert">{error}</p>}
                </div>
                <footer className="wizard-foot">
                    {step === "provider" ? null : <button type="button" className="button" disabled={busy} onClick={() => { setError(undefined); setStep(step === "model" ? "key" : "provider"); }}>Back</button>}
                    {step === "key" && selected?.connected ? <button type="button" className="button" disabled={busy} onClick={() => {
                        setBusy(true); setError(undefined);
                        void loadModels(selected.id).finally(() => setBusy(false));
                    }}>Choose models</button> : null}
                    {step === "key" ? <button type="button" className="button" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : selected?.methods.includes("browser") ? "Sign in" : "Connect"}</button> : null}
                    {step === "model" ? <button type="button" className="button" disabled={busy || model === ""} onClick={() => void finish()}>{busy ? "Checking…" : "Use model"}</button> : null}
                </footer>
            </div>
        </div>
    );
}
