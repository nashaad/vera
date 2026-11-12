import type { ProbeOutcome } from "../controls.ts";
import type { ModelEntry } from "../settings.ts";
import { modelFacts, probeLine } from "./rows.ts";

export interface ModelDetailProps {
    readonly entry: ModelEntry | undefined;
    readonly pinned: boolean;
    readonly enabled: boolean;
    readonly providerName: (provider: string) => string;
    readonly probing: boolean;
    readonly probeBusy: boolean;
    readonly probeResult: ProbeOutcome | undefined;
    readonly onPick: (entry: ModelEntry) => void;
    readonly onPin: (entry: ModelEntry, on: boolean) => void;
    readonly onProbe: (entry: ModelEntry) => void;
}

export function ModelDetail(props: ModelDetailProps) {
    const { entry } = props;
    if (entry === undefined) return <aside className="models-detail"><div className="models-empty">Select a model</div></aside>;
    const pinLabel = props.pinned ? "Remove from favorites" : "Add to favorites";
    return (
        <aside className="models-detail">
            <div className="models-detail-name">{entry.shortLabel ?? entry.label}</div>
            <div className="models-detail-provider">
                {entry.maker === undefined ? "" : `${entry.maker} · `}
                {props.providerName(entry.provider)}
            </div>
            {entry.description !== undefined && <p className="models-description">{entry.description}</p>}
            <div className="models-facts">
                {modelFacts(entry, props.pinned).map((fact) => (
                    <div className="models-fact" key={fact.label}>
                        <span className="models-fact-key">{fact.label}</span>
                        <span className="models-fact-value" data-good={fact.good === true} data-mono={fact.mono === true}>
                            {fact.value}
                        </span>
                    </div>
                ))}
            </div>
            <div className="models-actions">
                <button
                    type="button"
                    className="button button-primary models-button"
                    disabled={!props.enabled}
                    onClick={() => props.onPick(entry)}
                >
                    Run this model
                </button>
                <button
                    type="button"
                    className="button models-button"
                    disabled={!props.enabled}
                    onClick={() => props.onPin(entry, !props.pinned)}
                >
                    {pinLabel}
                </button>
                <button
                    type="button"
                    className="button models-button"
                    disabled={!props.enabled || props.probeBusy}
                    onClick={() => props.onProbe(entry)}
                >
                    {props.probing ? "Probing…" : "Probe it"}
                </button>
            </div>
            {props.probeResult !== undefined && <div className="models-probe">{probeLine(props.probeResult)}</div>}
            <div className="models-note">Sends one short request to check that the model answers.</div>
        </aside>
    );
}
