import { shortenPath } from "../components/homePath.ts";
import { buildLabel, phaseLabel, toneOf, type UiState } from "../state/connection.ts";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

interface StatProps {
    readonly name: string;
    readonly label: string;
    readonly value: string;
}

function Stat({ name, label, value }: StatProps) {
    return (
        <div className="stat">
            <dt className="stat-label">{label}</dt>
            <dd className="stat-value" data-stat={name}>{value}</dd>
        </div>
    );
}

const PENDING = "...";

export function HostView(_props: ViewProps) {
    const { connection: state } = useViewEnvironment();
    const attached = state.phase === "attached";
    return (
        <div className="host-view" aria-label="Connection">
            <p className="kicker" data-tone={toneOf(state)}>
                <span className="dot" />
                {phaseLabel(state)}
            </p>
            {attached ? (
                <dl className="stats">
                    <Stat
                        name="sessions"
                        label="Sessions"
                        value={state.sessions === undefined ? PENDING : String(state.sessions)}
                    />
                    <Stat name="host" label="Host build" value={buildLabel(state)} />
                    <Stat
                        name="protocol"
                        label="Protocol"
                        value={state.identity === undefined ? PENDING : `v${state.identity.protocol_version}`}
                    />
                    <Stat name="pid" label="Host process" value={String(state.ready?.pid ?? PENDING)} />
                    {state.ready !== undefined ? (
                        <div className="stat stat-wide">
                            <dt className="stat-label">Home</dt>
                            <dd className="stat-value stat-path" data-stat="home" title={state.ready.home}>{shortenPath(state.ready.home)}</dd>
                        </div>
                    ) : null}
                </dl>
            ) : null}
            {state.notice !== undefined ? <p className="meta">{state.notice}</p> : null}
            {state.checked !== undefined && state.checked.length > 0 ? (
                <p className="meta">Checked: {state.checked.join(", ")}</p>
            ) : null}
            {!attached && state.ready !== undefined ? <p className="meta">{state.ready.home}</p> : null}
        </div>
    );
}
