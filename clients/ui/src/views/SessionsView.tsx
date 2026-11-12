import { useState } from "react";

import { ChevronRightIcon } from "../components/Icons.tsx";
import { groupSessions, type SessionGroup } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

function isRunning(row: SessionRow): boolean {
    return row.status === "working" || row.status === "waiting";
}

function Row({ row, nested, now }: { readonly row: SessionRow; readonly nested: boolean; readonly now: number }) {
    const running = isRunning(row);
    return (
        <li
            className="session-row"
            data-session={row.id}
            data-live={row.live}
            data-status={row.status}
            data-nested={nested}
            title={row.name}
        >
            <span className="session-dot" data-running={running} aria-hidden="true" />
            <span className="session-name">{row.name}</span>
            <span className="session-time">{running ? "" : relativeTime(row.updatedAt, now)}</span>
        </li>
    );
}

function Group({ group, now }: { readonly group: SessionGroup; readonly now: number }) {
    const [open, setOpen] = useState(true);
    return (
        <section className="session-group" data-workspace={group.workspace} data-open={open}>
            <div className="group-head">
                <button
                    type="button"
                    className="group-disclose"
                    aria-label={open ? `Collapse ${group.title}` : `Expand ${group.title}`}
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                >
                    <ChevronRightIcon className="group-chevron" />
                </button>
                <button
                    type="button"
                    className="group-title"
                    title={group.workspace}
                    onClick={() => setOpen(!open)}
                >
                    {group.title}
                </button>
            </div>
            {open ? (
                <ul className="session-list">
                    {group.entries.map(({ row, nested }) => <Row key={row.id} row={row} nested={nested} now={now} />)}
                </ul>
            ) : null}
        </section>
    );
}

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
            {groupSessions(rows).map((group) => <Group key={group.workspace} group={group} now={now} />)}
            {total !== undefined && total > rows.length ? (
                <p className="view-note">Showing the latest {rows.length} of {total}.</p>
            ) : null}
        </>
    );
}
