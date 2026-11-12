import { relativeTime } from "../protocol/sessions.ts";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

export function SessionsView(_props: ViewProps) {
    const { connection: state } = useViewEnvironment();
    const rows = state.sessionRows;
    if (state.phase !== "attached" || rows === undefined) {
        return <p className="view-empty">{state.phase === "attached" ? "Loading sessions." : "Not connected to the host."}</p>;
    }
    if (rows.length === 0) return <p className="view-empty">No sessions in this home yet.</p>;
    const now = Date.now();
    const total = state.sessions;
    return (
        <>
            <ul className="session-list">
                {rows.map((row) => (
                    <li key={row.id} className="session-row" data-session={row.id} data-live={row.live}>
                        <span className="session-dot" aria-hidden="true" />
                        <span className="session-name" title={row.name}>{row.name}</span>
                        <span className="session-time">{relativeTime(row.updatedAt, now)}</span>
                    </li>
                ))}
            </ul>
            {total !== undefined && total > rows.length ? (
                <p className="view-note">Showing the latest {rows.length} of {total}.</p>
            ) : null}
        </>
    );
}
