import { phaseLabel, buildLabel, toneOf, type UiState } from "../state/connection.ts";

interface StatTileProps {
    readonly name: string;
    readonly label: string;
    readonly value: string;
}

function StatTile({ name, label, value }: StatTileProps) {
    return (
        <div className="stat">
            <dt className="stat-label">{label}</dt>
            <dd className="stat-value" data-stat={name}>{value}</dd>
        </div>
    );
}

const PENDING = "...";

function headlineFor(state: UiState): string {
    if (state.phase === "attached") return "Attached to this home's host";
    if (state.phase === "starting" || state.phase === "waiting") return "Attaching to the Vera host";
    return "No host connection";
}

function detailFor(state: UiState): string {
    switch (state.phase) {
        case "attached":
            return "The desktop reads from the host the same way the terminal client does.";
        case "starting":
            return "Starting the host for this home if none is running.";
        case "waiting":
            return "Another Vera is starting this home. Waiting for it.";
        default:
            return "The banner above has the reason and the way back.";
    }
}

export function ConnectionPanel({ state }: { readonly state: UiState }) {
    const attached = state.phase === "attached";
    return (
        <section className="panel" aria-label="Connection">
            <p className="kicker" data-tone={toneOf(state)}>
                <span className="dot" />
                {phaseLabel(state)}
            </p>
            <h1 className="headline">{headlineFor(state)}</h1>
            <p className="detail">{detailFor(state)}</p>
            {attached ? (
                <dl className="stats">
                    <StatTile
                        name="sessions"
                        label="Sessions"
                        value={state.sessions === undefined ? PENDING : String(state.sessions)}
                    />
                    <StatTile name="host" label="Host build" value={buildLabel(state)} />
                    <StatTile
                        name="protocol"
                        label="Protocol"
                        value={state.identity === undefined ? PENDING : `v${state.identity.protocol_version}`}
                    />
                    <StatTile
                        name="pid"
                        label="Host process"
                        value={String(state.ready?.pid ?? PENDING)}
                    />
                </dl>
            ) : null}
            {state.notice !== undefined ? <p className="meta">{state.notice}</p> : null}
            {state.checked !== undefined && state.checked.length > 0 ? (
                <p className="meta">Checked: {state.checked.join(", ")}</p>
            ) : null}
            {state.ready !== undefined ? <p className="meta">{state.ready.home}</p> : null}
        </section>
    );
}
