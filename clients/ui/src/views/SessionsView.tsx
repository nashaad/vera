import { useState, type MouseEvent } from "react";

import { sessionRowMenu } from "../commands/session-row-menu.ts";
import { ChevronRightIcon, MoreIcon } from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
import { groupSessions, type SessionGroup } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";
import { isPinned, usePinnedSessions } from "../state/usePins.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

function isRunning(row: SessionRow): boolean {
    return row.status === "working" || row.status === "waiting";
}

function Row({ row, nested, now }: { readonly row: SessionRow; readonly nested: boolean; readonly now: number }) {
    const running = isRunning(row);
    const { route, navigate } = useRouter();
    const { openMenu } = useWorkbench();
    const active = route.kind === "session" && route.agentId === row.id;
    const menu = (at: { readonly x: number; readonly y: number }): void => openMenu(sessionRowMenu(row, isPinned(row.id)), at);
    const more = (event: MouseEvent<HTMLButtonElement>): void => {
        const box = event.currentTarget.getBoundingClientRect();
        menu({ x: box.left, y: box.bottom });
    };
    const context = (event: MouseEvent<HTMLLIElement>): void => {
        event.preventDefault();
        menu({ x: event.clientX, y: event.clientY });
    };
    return (
        <li className="session-item" onContextMenu={context}>
            <button
                type="button"
                className="session-row"
                data-session={row.id}
                data-live={row.live}
                data-status={row.status}
                data-nested={nested}
                data-active={active}
                aria-current={active ? "page" : undefined}
                title={row.name}
                onClick={() => navigate({ kind: "session", agentId: row.id, title: row.name })}
            >
                <span className="session-dot" data-running={running} aria-hidden="true" />
                <span className="session-name">{row.name}</span>
                <span className="session-time">{running ? "" : relativeTime(row.updatedAt, now)}</span>
            </button>
            <button
                type="button"
                className="session-more"
                aria-label={`${row.name} menu`}
                aria-haspopup="menu"
                title="Session menu"
                onClick={more}
            >
                <MoreIcon />
            </button>
        </li>
    );
}

function Group({ group, now }: { readonly group: SessionGroup; readonly now: number }) {
    const [open, setOpen] = useState(true);
    const { route, navigate } = useRouter();
    const active = route.kind === "workspace" && route.folder === group.workspace;
    return (
        <section className="session-group" data-group={group.key} data-workspace={group.workspace} data-open={open}>
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
                    title={group.workspace === "" ? undefined : `Open ${group.workspace}`}
                    data-active={active}
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                        if (group.workspace === "") setOpen(!open);
                        else navigate({ kind: "workspace", folder: group.workspace });
                    }}
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
    const pins = usePinnedSessions();
    const rows = state.sessionRows;
    if (state.phase !== "attached" || rows === undefined) {
        return <p className="view-empty">{state.phase === "attached" ? "Loading sessions." : "Not connected to the host."}</p>;
    }
    if (rows.length === 0) return <p className="view-empty">No sessions in this home yet.</p>;
    const now = Date.now();
    const total = state.sessions;
    return (
        <>
            {groupSessions(rows, pins).map((group) => <Group key={group.key} group={group} now={now} />)}
            {total !== undefined && total > rows.length ? (
                <p className="view-note">Showing the latest {rows.length} of {total}.</p>
            ) : null}
        </>
    );
}
