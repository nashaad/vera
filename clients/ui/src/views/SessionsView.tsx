import { useEffect, useState, type MouseEvent } from "react";

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
    readonly working: number;
    readonly onToggle: () => void;
}

function Row({ row, archiveRoot, nested, last, fold, now }: { readonly row: SessionRow; readonly archiveRoot: SessionRow | undefined; readonly nested: boolean; readonly last: boolean; readonly fold: Fold | undefined; readonly now: number }) {
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
    const navigateRow = (): void => navigate({ kind: "session", agentId: row.id, title: row.name });
    const lineClick = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.target instanceof Element && event.target.closest("button") === null) navigateRow();
    };
    const context = (event: MouseEvent<HTMLLIElement>): void => {
        event.preventDefault();
        menu({ x: event.clientX, y: event.clientY });
    };
    return (
        <li className="session-item" data-parent={fold !== undefined} data-nested={nested} data-last={last} onContextMenu={context}>
            <div className="session-line" onClick={lineClick}>
                <button
                    type="button"
                    className="session-row"
                    data-session={row.id}
                    data-live={row.live}
                    data-status={row.status}
                    data-nested={nested}
                    data-active={active}
                    aria-current={active ? "page" : undefined}
                    aria-label={row.status === "working" ? `${row.name}, Working` : row.status === "waiting" ? `${row.name}, Waiting on you` : row.name}
                    title={row.name}
                    onClick={navigateRow}
                >
                    <span className="session-name">{row.name}</span>
                </button>
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
                <span className="session-line-spacer" />
                <span className="session-time">{running ? "" : relativeTime(row.updatedAt, now)}</span>
                {row.status === "working" ? (
                    <span className="session-spinner" role="img" aria-label="Working" />
                ) : (
                    <span className="session-dot" data-running={running} role={row.status === "waiting" ? "img" : undefined} aria-label={row.status === "waiting" ? "Waiting on you" : undefined} aria-hidden={row.status === "waiting" ? undefined : true} />
                )}
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
            </div>
            {fold?.folded === true ? (
                <button type="button" className="session-summary" onClick={fold.onToggle}>
                    {fold.count} nested{fold.working > 0 ? ` · ${fold.working} working` : ""}
                </button>
            ) : null}
        </li>
    );
}

interface GroupProps {
    readonly group: SessionGroup;
    readonly expanded: ReadonlySet<string>;
    readonly onToggleFold: (id: string) => void;
    readonly now: number;
}

// A folded parent hides the rows nested under it; entries keep the host's order with each parent first.
function visibleEntries(group: SessionGroup, expanded: ReadonlySet<string>): readonly SessionEntry[] {
    const shown: SessionEntry[] = [];
    let hiding = false;
    for (const entry of group.entries) {
        if (!entry.nested) hiding = entry.nestedCount > 0 && !expanded.has(entry.row.id);
        else if (hiding) continue;
        shown.push(entry);
    }
    return shown;
}

function workingNestedCount(entries: readonly SessionEntry[], parentId: string, count: number): number {
    const parentIndex = entries.findIndex((entry) => entry.row.id === parentId);
    let working = 0;
    for (let index = parentIndex + 1; index <= parentIndex + count; index += 1) {
        if (entries[index]?.row.status === "working") working += 1;
    }
    return working;
}

function Group({ group, expanded, onToggleFold, now }: GroupProps) {
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
                    {visibleEntries(group, expanded).map(({ row, archiveRoot, nested, nestedCount }, index, entries) => (
                        <Row
                            key={row.id}
                            row={row}
                            archiveRoot={archiveRoot}
                            nested={nested}
                            last={nested && (entries[index + 1]?.nested !== true)}
                            fold={nestedCount === 0 ? undefined : {
                                count: nestedCount,
                                working: workingNestedCount(group.entries, row.id, nestedCount),
                                folded: !expanded.has(row.id),
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

export function SessionsView({ visible }: ViewProps) {
    const { connection: state } = useViewEnvironment();
    const [windowShown, setWindowShown] = useState(true);
    const [documentShown, setDocumentShown] = useState(() => document.visibilityState === "visible");
    useEffect(() => {
        const update = (): void => setDocumentShown(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", update);
        const off = window.veraDesktop?.onEvent((event) => {
            if (event.type === "window_shown") setWindowShown(event.shown);
        });
        return () => { document.removeEventListener("visibilitychange", update); off?.(); };
    }, []);
    const pins = usePinnedSessions();
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const rows = state.sessionRows;
    useEffect(() => {
        if (rows === undefined) return;
        const ids = new Set(rows.map((row) => row.id));
        setExpanded((current) => {
            const kept = [...current].filter((id) => ids.has(id));
            return kept.length === current.size ? current : new Set(kept);
        });
    }, [rows]);
    if (state.phase !== "attached" || rows === undefined) {
        return <p className="view-empty">{state.phase === "attached" ? "Loading sessions." : "Not connected to the host."}</p>;
    }
    if (rows.length === 0) return <p className="view-empty">No sessions in this home yet.</p>;
    const now = Date.now();
    const total = state.sessions;
    const toggleFold = (id: string): void => setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
    });
    return (
        <div className="sessions-view" data-motion-visible={visible && windowShown && documentShown}>
            {groupSessions(rows, pins).map((group) => (
                <Group key={group.key} group={group} expanded={expanded} onToggleFold={toggleFold} now={now} />
            ))}
            {total !== undefined && total > rows.length ? (
                <p className="view-note">Showing the latest {rows.length} of {total}.</p>
            ) : null}
        </div>
    );
}
