import { useState, type MouseEvent } from "react";

import { sessionRowMenu } from "../commands/session-row-menu.ts";
import { ChevronRightIcon, MoreIcon } from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
import { ARCHIVED_KEY, groupSessions, type SessionEntry, type SessionGroup } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";
import { isPinned, usePinnedSessions } from "../state/usePins.ts";
import { useSurface } from "../state/useSurfaces.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

function isRunning(row: SessionRow): boolean {
    return row.status === "working" || row.status === "waiting";
}

interface Fold {
    readonly count: number;
    readonly folded: boolean;
    readonly onToggle: () => void;
}

function Row({ row, archiveRoot, nested, fold, now }: { readonly row: SessionRow; readonly archiveRoot: SessionRow | undefined; readonly nested: boolean; readonly fold: Fold | undefined; readonly now: number }) {
    const running = isRunning(row);
    const { route, navigate } = useRouter();
    const { openMenu } = useWorkbench();
    const files = useSurface("files");
    const active = route.kind === "session" && route.agentId === row.id;
    const menu = (at: { readonly x: number; readonly y: number }): void => openMenu(sessionRowMenu(row, isPinned(row.id), files, archiveRoot), at);
    const more = (event: MouseEvent<HTMLButtonElement>): void => {
        const box = event.currentTarget.getBoundingClientRect();
        menu({ x: box.left, y: box.bottom });
    };
    const context = (event: MouseEvent<HTMLLIElement>): void => {
        event.preventDefault();
        menu({ x: event.clientX, y: event.clientY });
    };
    return (
        <li className="session-item" data-parent={fold !== undefined} onContextMenu={context}>
            {fold === undefined ? null : (
                <button
                    type="button"
                    className="session-fold"
                    aria-label={`${fold.folded ? "Expand" : "Collapse"} ${row.name} subagents`}
                    aria-expanded={!fold.folded}
                    title={fold.folded ? "Show subagents" : "Hide subagents"}
                    onClick={fold.onToggle}
                >
                    <ChevronRightIcon className="session-fold-icon" />
                </button>
            )}
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
                {fold?.folded === true ? <span className="session-nested">{fold.count} nested</span> : null}
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

interface GroupProps {
    readonly group: SessionGroup;
    readonly folded: ReadonlySet<string>;
    readonly onToggleFold: (id: string) => void;
    readonly now: number;
}

// A folded parent hides the rows nested under it; entries keep the host's order with each parent first.
function visibleEntries(group: SessionGroup, folded: ReadonlySet<string>): readonly SessionEntry[] {
    const shown: SessionEntry[] = [];
    let hiding = false;
    for (const entry of group.entries) {
        if (!entry.nested) hiding = entry.nestedCount > 0 && folded.has(entry.row.id);
        else if (hiding) continue;
        shown.push(entry);
    }
    return shown;
}

function Group({ group, folded, onToggleFold, now }: GroupProps) {
    const [open, setOpen] = useState(group.key !== ARCHIVED_KEY);
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
                    {visibleEntries(group, folded).map(({ row, archiveRoot, nested, nestedCount }) => (
                        <Row
                            key={row.id}
                            row={row}
                            archiveRoot={archiveRoot}
                            nested={nested}
                            fold={nestedCount === 0 ? undefined : {
                                count: nestedCount,
                                folded: folded.has(row.id),
                                onToggle: () => onToggleFold(row.id),
                            }}
                            now={now}
                        />
                    ))}
                </ul>
            ) : null}
        </section>
    );
}

export function SessionsView(_props: ViewProps) {
    const { connection: state } = useViewEnvironment();
    const pins = usePinnedSessions();
    // Folded parents live here, not in a group, so a parent keeps its state when it moves between groups.
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
    const rows = state.sessionRows;
    if (state.phase !== "attached" || rows === undefined) {
        return <p className="view-empty">{state.phase === "attached" ? "Loading sessions." : "Not connected to the host."}</p>;
    }
    if (rows.length === 0) return <p className="view-empty">No sessions in this home yet.</p>;
    const now = Date.now();
    const total = state.sessions;
    const toggleFold = (id: string): void => setFolded((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
    });
    return (
        <>
            {groupSessions(rows, pins).map((group) => (
                <Group key={group.key} group={group} folded={folded} onToggleFold={toggleFold} now={now} />
            ))}
            {total !== undefined && total > rows.length ? (
                <p className="view-note">Showing the latest {rows.length} of {total}.</p>
            ) : null}
        </>
    );
}
