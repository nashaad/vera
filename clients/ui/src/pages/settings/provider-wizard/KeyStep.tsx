import { useState } from "react";

import type { ProviderStatus } from "../../../protocol/bridge.ts";

interface KeyStepProps {
    readonly provider?: ProviderStatus;
    readonly custom: boolean;
    readonly id: string;
    readonly endpoint: string;
    readonly apiKey: string;
    readonly replacing: boolean;
    readonly busy: boolean;
    readonly onIdChange: (value: string) => void;
    readonly onEndpointChange: (value: string) => void;
    readonly onKeyChange: (value: string) => void;
    readonly onReplace: () => void;
}

export function keyEcho(apiKey: string): string {
    return apiKey.length === 0 ? "" : apiKey.length <= 6 ? `${apiKey.length} characters` : `${apiKey.length} characters, starting ${apiKey.slice(0, 6)}…`;
}

export function KeyStep(props: KeyStepProps) {
    const [keyFocused, setKeyFocused] = useState(false);
    const browser = props.provider?.methods.includes("browser") === true;
    const local = props.provider !== undefined && props.provider.methods.length === 0;
    const environment = props.provider?.connected_by === "environment";
    const stored = props.provider?.connected === true && !props.replacing && !browser && !local && !environment;
    const echo = keyFocused ? keyEcho(props.apiKey) : "";
    return (
        <div className="provider-wizard-key-step">
            {props.custom ? <label>Provider name<input autoFocus value={props.id} onChange={(event) => props.onIdChange(event.target.value)} /></label> : browser ? <p>Sign in in your browser.</p> : null}
            {local ? <p>{props.provider?.connected ? "Connected" : ""}</p> : browser ? null : environment ? <p>Provided by the environment</p> : stored ? (
                <div className="provider-wizard-stored"><span>Stored in Vera</span><button type="button" className="button" onClick={props.onReplace}>Replace</button></div>
            ) : <>
                {props.provider?.name ? <p>Enter your {props.provider.name} API key.</p> : null}
                <label>{props.provider?.name ? `${props.provider.name} API key` : "API key"}<input autoFocus={!props.custom} aria-label={props.provider?.name ? `${props.provider.name} API key` : "API key"} type="password" value={props.apiKey} onFocus={() => setKeyFocused(true)} onBlur={() => setKeyFocused(false)} onChange={(event) => props.onKeyChange(event.target.value)} /></label>
                {echo ? <p className="provider-wizard-key-echo" aria-live="polite">{echo}</p> : null}
                {props.custom ? <label>Endpoint<input aria-label="Endpoint" value={props.endpoint} onChange={(event) => props.onEndpointChange(event.target.value)} /></label> : <details className="provider-wizard-endpoint"><summary>Endpoint</summary><label>Endpoint<input aria-label="Endpoint" value={props.endpoint} onChange={(event) => props.onEndpointChange(event.target.value)} /></label></details>}
            </>}
        </div>
    );
}
