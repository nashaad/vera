import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { ArrowLeftIcon, LayersIcon, SearchIcon, XIcon } from "../../components/Icons.tsx";
import { parseModelSettings, type ModelEntry } from "../../models/settings.ts";
import type { DesktopBridge, ProviderStatus } from "../../protocol/bridge.ts";
import { KeyStep } from "./provider-wizard/KeyStep.tsx";
import { loadProviderModels } from "./provider-wizard/load-models.ts";
import { ModelStep } from "./provider-wizard/ModelStep.tsx";
import { ProviderStep } from "./provider-wizard/ProviderStep.tsx";
import { ProviderWizardFooter } from "./provider-wizard/ProviderWizardFooter.tsx";
import "../../styles/provider-cards.css";
import "../../styles/provider-setup.css";

type ProviderWizardStep = "provider" | "key" | "model";

interface ProviderWizardProps {
    readonly onClose: () => void;
    readonly onComplete?: () => void;
    readonly initialProvider?: string;
    readonly initialProviderStatus?: ProviderStatus;
    readonly initialCustom?: boolean;
    readonly initialReplace?: boolean;
}

export function ProviderWizard({ onClose, onComplete, initialProvider, initialProviderStatus, initialCustom = false, initialReplace = false }: ProviderWizardProps) {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    const [providers, setProviders] = useState<readonly ProviderStatus[]>([]);
    const [providersLoaded, setProvidersLoaded] = useState(initialProviderStatus !== undefined);
    const [runningProvider, setRunningProvider] = useState<string | undefined>();
    const [step, setStep] = useState<ProviderWizardStep>(initialProviderStatus !== undefined || initialCustom ? "key" : "provider");
    const [selected, setSelected] = useState<ProviderStatus | undefined>(initialProviderStatus);
    const [custom, setCustom] = useState(initialProviderStatus?.custom ?? initialCustom);
    const [replacing, setReplacing] = useState(initialReplace);
    const [id, setId] = useState(initialProviderStatus?.id ?? "");
    const [endpoint, setEndpoint] = useState(initialProviderStatus?.endpoint ?? "");
    const [key, setKey] = useState("");
    const [models, setModels] = useState<readonly ModelEntry[]>([]);
    const [model, setModel] = useState("");
    const [query, setQuery] = useState("");
    const [providerQuery, setProviderQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const requestVersion = useRef(0);
    const sheet = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        sheet.current?.querySelector<HTMLButtonElement>("button")?.focus();
        return () => {
            requestVersion.current += 1;
            previous?.focus();
        };
    }, []);

    useLayoutEffect(() => {
        const selector = step === "provider" ? ".provider-wizard-provider-search input"
            : step === "model" ? ".provider-wizard-model-search input"
                : ".provider-wizard-key-step input, .provider-wizard-footer button";
        sheet.current?.querySelector<HTMLElement>(selector)?.focus();
    }, [step, providersLoaded]);

    useLayoutEffect(() => {
        const onKey = (event: globalThis.KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (busy) {
                requestVersion.current += 1;
                if (selected?.methods.includes("browser")) bridge?.cancelProviderSignIn();
                setBusy(false);
            }
            if (step === "provider") onClose();
            else { setError(undefined); setStep(step === "model" ? "key" : "provider"); }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [bridge, busy, onClose, selected, step]);

    useEffect(() => {
        let live = true;
        if (bridge === undefined) return;
        void bridge.readModelSettings().then((result) => {
            if (live && result.ok) setRunningProvider(parseModelSettings(result.settings)?.provider);
        }).catch(() => {});
        void bridge.listProviders().then((result) => {
            if (!live) return;
            setProvidersLoaded(true);
            if (!result.ok) {
                if (initialProviderStatus === undefined) setStep("provider");
                setError(result.reason);
                return;
            }
            setProviders(result.providers);
            if (initialProviderStatus !== undefined) {
                const fresh = result.providers.find((provider) => provider.id === initialProviderStatus.id);
                if (fresh !== undefined) setSelected((current) => current?.id === fresh.id ? fresh : current);
                return;
            }
            const initial = result.providers.find((provider) => provider.id === initialProvider);
            if (initial !== undefined) {
                setSelected(initial);
                setCustom(initial.custom);
                setId(initial.id);
                setEndpoint(initial.endpoint ?? "");
                setReplacing(initialReplace);
                setStep("key");
            }
        }).catch(() => {
            if (!live) return;
            setProvidersLoaded(true);
            if (initialProviderStatus === undefined) setStep("provider");
            setError("Could not connect the provider.");
        });
        return () => { live = false; bridge.cancelProviderSignIn(); };
    }, [bridge, initialProvider, initialProviderStatus, initialReplace]);

    function choose(provider: ProviderStatus): void {
        setSelected(provider);
        setCustom(provider.custom);
        setReplacing(false);
        setId(provider.id);
        setEndpoint(provider.endpoint ?? "");
        setKey("");
        setError(undefined);
        setStep("key");
    }

    function chooseCustom(): void {
        setSelected(undefined);
        setCustom(true);
        setReplacing(false);
        setId("");
        setEndpoint("");
        setKey("");
        setError(undefined);
        setStep("key");
    }

    function goTo(target: ProviderWizardStep): void {
        if (busy) {
            requestVersion.current += 1;
            if (selected?.methods.includes("browser")) bridge?.cancelProviderSignIn();
            setBusy(false);
        }
        setError(undefined);
        setStep(target);
    }

    async function loadModels(provider: string, version: number): Promise<void> {
        if (bridge === undefined) return;
        const { rows, settings, failure } = await loadProviderModels(bridge, provider);
        if (requestVersion.current !== version) return;
        setModels(rows);
        const current = settings?.provider === provider ? settings.model : "";
        setModel(rows.some((entry) => entry.model === current) ? current : rows.find((entry) => entry.recommended)?.model ?? rows[0]?.model ?? "");
        setQuery("");
        setStep("model");
        setError(failure ?? (rows.length === 0 ? "No models were found. Try refreshing the provider." : undefined));
    }

    async function connect(): Promise<void> {
        if (bridge === undefined || busy) return;
        const version = ++requestVersion.current;
        setBusy(true);
        setError(undefined);
        try {
            if (selected?.methods.includes("browser")) {
                const result = await bridge.signInProvider(selected.id);
                if (requestVersion.current !== version) return;
                if (!result.ok) { setError(result.reason); return; }
                setSelected(result.provider);
                await loadModels(result.provider.id, version);
            } else {
                const result = await bridge.saveProvider({
                    provider: id.trim(), key, endpoint: endpoint.trim(),
                    protocol: selected?.protocol ?? "openai-chat", custom,
                    ...(selected?.connected ? { editing: selected.id } : {}),
                });
                if (requestVersion.current !== version) return;
                if (!result.ok) { setError(result.reason); return; }
                setSelected(result.provider);
                setKey("");
                await loadModels(result.provider.id, version);
            }
        } catch { if (requestVersion.current === version) setError("Could not connect the provider."); }
        finally { if (requestVersion.current === version) setBusy(false); }
    }

    async function continueToModels(): Promise<void> {
        if (selected === undefined || busy) return;
        if (!selected.connected && selected.methods.length === 0) {
            await connect();
            return;
        }
        const version = ++requestVersion.current;
        setBusy(true);
        setError(undefined);
        try {
            await loadModels(selected.id, version);
        } catch {
            if (requestVersion.current === version) setError("Could not connect the provider.");
        } finally {
            if (requestVersion.current === version) setBusy(false);
        }
    }

    function submitKeyStep(): void {
        const browser = selected?.methods.includes("browser") === true;
        const local = selected !== undefined && selected.methods.length === 0;
        const continueExisting = !browser && (selected?.connected === true || local) && !replacing;
        if (continueExisting) void continueToModels();
        else void connect();
    }

    async function finish(): Promise<void> {
        if (bridge === undefined || busy || model === "") return;
        const version = ++requestVersion.current;
        setBusy(true);
        setError(undefined);
        try {
            const result = await bridge.selectProviderModel(selected?.id ?? id, model);
            if (requestVersion.current !== version) return;
            if (!result.ok) { setError(result.reason); return; }
            onComplete?.();
            onClose();
        } catch { if (requestVersion.current === version) setError("The model did not answer."); }
        finally { if (requestVersion.current === version) setBusy(false); }
    }

    function onSheetKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])',
        )].filter((element) => element.getClientRects().length > 0);
        if (controls.length === 0) return;
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) {
            event.preventDefault();
            controls[controls.length - 1]?.focus();
        } else if (!event.shiftKey && (index === -1 || index === controls.length - 1)) {
            event.preventDefault();
            controls[0]?.focus();
        }
    }

    function onProviderListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".provider-wizard-provider-row, .provider-wizard-custom-row")];
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0);
        event.preventDefault();
        rows[next]?.focus();
    }

    if (!providersLoaded) return null;

    return (
        <div className="provider-wizard-scrim">
            <div ref={sheet} className="provider-wizard-sheet" role="dialog" aria-modal="true" aria-label={step === "provider" ? "Connect a provider" : step === "model" ? "Choose a model" : `Connect ${selected?.name ?? (id.trim() || "Custom provider")}`} onKeyDown={onSheetKeyDown}>
                <header className="provider-wizard-head">
                    <button type="button" aria-label="Back" onClick={() => { if (step === "provider") onClose(); else goTo(step === "model" ? "key" : "provider"); }}><ArrowLeftIcon /></button>
                    <LayersIcon className="provider-wizard-head-icon" />
                    <h2>{step === "provider" ? "Connect a provider" : step === "model" ? "Choose a model" : `Connect ${selected?.name ?? (id.trim() || "Custom provider")}`}</h2>
                    <button type="button" aria-label="Close" onClick={onClose}><XIcon /></button>
                </header>
                <form className="provider-wizard-form" onSubmit={(event) => { event.preventDefault(); if (step === "key") submitKeyStep(); else if (step === "model") void finish(); }}>
                    <div className="provider-wizard-body">
                        {step === "provider" ? <div onKeyDown={onProviderListKeyDown}>
                            <div className="provider-wizard-model-search"><SearchIcon /><input autoFocus aria-label="Search providers" placeholder="Search providers" value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} /></div>
                            <ProviderStep providers={providers} runningProvider={runningProvider} query={providerQuery} onChoose={choose} onCustom={chooseCustom} />
                        </div> : null}
                        {step === "key" ? <KeyStep provider={selected} custom={custom} id={id} endpoint={endpoint} apiKey={key} replacing={replacing} busy={busy} onIdChange={setId} onEndpointChange={setEndpoint} onKeyChange={setKey} onReplace={() => { setReplacing(true); setKey(""); }} /> : null}
                        {step === "model" ? <ModelStep models={models} model={model} query={query} onModelChange={setModel} onQueryChange={setQuery} /> : null}
                        {error === undefined ? null : <p className="provider-wizard-error" role="alert">{error}</p>}
                    </div>
                    <ProviderWizardFooter step={step} provider={selected} replacing={replacing} busy={busy} id={id} apiKey={key} model={model} />
                </form>
            </div>
        </div>
    );
}
