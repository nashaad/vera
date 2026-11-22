import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { sessionRowMenu } from "../commands/session-row-menu.ts";
import {
    BubbleQuestionIcon,
    ChevronRightIcon,
    FolderIcon,
    MoreIcon,
    PinIcon,
    PinOffIcon,
} from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";
import { ARCHIVED_KEY, buildSidebarTree, type SidebarNode, type SidebarSection } from "../protocol/sidebarTree.ts";
import { requestComposerFocus } from "../session/composerFocus.ts";
import { takePinFocus, toggleSessionPin, usePinnedSessions } from "../state/usePins.ts";
import { useSidebarGrouping } from "../state/useSidebarGrouping.ts";
import { useSurface } from "../state/useSurfaces.ts";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

interface VisibleRow {
    readonly node: SidebarNode;
    readonly parentId?: string;
    readonly depth: number;
    // True at the top of a family, where Pin and the question indicator live.
    readonly root: boolean;
    // A section heading puts its rows one column in, behind a folder guide line.
    readonly headed: boolean;
    // The ancestor columns that continue past this row.
    readonly guides: readonly boolean[];
    readonly last: boolean;
}

function visibleRows(section: SidebarSection, expanded: ReadonlySet<string>): readonly VisibleRow[] {
    // A shared folder row takes the heading's place and starts at the left edge like one.
    const headed = (section.kind === "folder" && !section.folderRow) || section.kind === "chats" || section.kind === "archived";
    const rows: VisibleRow[] = [];
    const walk = (
        node: SidebarNode,
        treeDepth: number,
        parentId: string | undefined,
        guides: readonly boolean[],
        last: boolean,
    ): void => {
        rows.push({
            node,
            parentId,
            depth: treeDepth + (headed ? 1 : 0),
            root: treeDepth === 0,
            headed,
            guides,
            last,
        });
        if (!expanded.has(node.row.id)) return;
        node.children.forEach((child, index) => {
            const lastChild = index === node.children.length - 1;
            // A top-of-family row has no branch column of its own to continue.
            const nextGuides = treeDepth === 0 ? [] : [...guides, !last];
            walk(child, treeDepth + 1, node.row.id, nextGuides, lastChild);
        });
    };
    section.nodes.forEach((node, index) => walk(node, 0, undefined, [], index === section.nodes.length - 1));
    return rows;
}

function rowLabel(row: SessionRow): string {
    if (row.status === "working") return `${row.name}, Working`;
    if (row.status === "waiting") return `${row.name}, Waiting on you`;
    return row.name;
}

interface RowProps {
    readonly row: SessionRow;
    readonly archiveRoot: SessionRow;
    readonly depth: number;
    readonly root: boolean;
    readonly headed: boolean;
    readonly guides: readonly boolean[];
    readonly last: boolean;
    readonly folderRow: boolean;
    readonly pinned: boolean;
    readonly open: boolean;
    readonly childCount: number;
    readonly now: number;
    readonly onToggleFold: (id: string) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, id: string) => void;
}

function Row({
    row,
    archiveRoot,
    depth,
    root,
    headed,
    guides,
    last,
    folderRow,
    pinned,
    open,
    childCount,
    now,
    onToggleFold,
    onKeyDown,
}: RowProps) {
    const { route, navigate } = useRouter();
    const { openMenu } = useWorkbench();
    const files = useSurface("files");
    const active = route.kind === "session" && route.agentId === row.id;
    // Only a top-level row carries the question indicator; a nested row shows the working spinner only.
    const waitingHere = row.status === "waiting" && root;
    const menu = (at: { readonly x: number; readonly y: number }): void => {
        openMenu(sessionRowMenu(row, pinned, files, archiveRoot, root), at);
    };
    const more = (event: MouseEvent<HTMLButtonElement>): void => {
        const box = event.currentTarget.getBoundingClientRect();
        menu({ x: box.left, y: box.bottom });
    };
    const openRow = (): void => navigate({ kind: "session", agentId: row.id, title: row.name });
    const confirm = (): void => {
        navigate({ kind: "session", agentId: row.id, title: row.name });
        requestComposerFocus(row.id);
    };
    const lineClick = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.target instanceof Element && event.target.closest("button") === null) openRow();
    };
    const context = (event: MouseEvent<HTMLLIElement>): void => {
        event.preventDefault();
        menu({ x: event.clientX, y: event.clientY });
    };
    return (
        <li
            className="session-item"
            data-nested={!root}
            data-depth={depth}
            data-last={last}
            onContextMenu={context}
        >
            <div className="session-line" onClick={lineClick}>
                {headed ? <span className="session-branch" data-guide="true" aria-hidden="true" /> : null}
                {guides.map((continues, index) => (
                    <span key={index} className="session-branch" data-continue={continues} aria-hidden="true" />
                ))}
                {depth > 0 && (!headed || !root) ? (
                    <span className="session-branch" data-current="true" data-last={last} aria-hidden="true" />
                ) : null}
                <button
                    type="button"
                    className="session-row"
                    data-session={row.id}
                    data-live={row.live}
                    data-status={row.status}
                    data-nested={!root}
                    data-active={active}
                    aria-current={active ? "page" : undefined}
                    aria-label={rowLabel(row)}
                    title={row.name}
                    onClick={openRow}
                    onKeyDown={(event) => onKeyDown(event, row.id)}
                >
                    {folderRow ? <FolderIcon className="session-folder-icon" /> : null}
                    <span className="session-name" data-folder={folderRow}>{row.name}</span>
                </button>
                {childCount === 0 ? null : (
                    <button
                        type="button"
                        className="session-fold"
                        aria-label={`${open ? "Collapse" : "Expand"} ${row.name} subagents, ${childCount}`}
                        aria-expanded={open}
                        title={open ? "Hide subagents" : "Show subagents"}
                        onClick={() => onToggleFold(row.id)}
                    >
                        <span className="session-count">{childCount}</span>
                        <ChevronRightIcon className="session-fold-icon" />
                    </button>
                )}
                <span className="session-line-spacer" />
                {row.status === "working" ? (
                    <span className="session-spinner" role="img" aria-label="Working" />
                ) : waitingHere ? (
                    <button
                        type="button"
                        className="session-question"
                        aria-label={`Answer ${row.name}`}
                        title="Waiting on you"
                        onClick={confirm}
                    >
                        <BubbleQuestionIcon />
                    </button>
                ) : root ? (
                    <span className="session-time">{relativeTime(row.updatedAt, now)}</span>
                ) : null}
                <span className="session-more-slot">
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
                </span>
                {!root ? null : (
                    <button
                        type="button"
                        className="session-pin"
                        data-pin={row.id}
                        data-pinned={pinned}
                        aria-label={pinned ? `Unpin ${row.name}` : `Pin ${row.name}`}
                        aria-pressed={pinned}
                        title={pinned ? "Unpin session" : "Pin session"}
                        onClick={() => toggleSessionPin(row.id)}
                    >
                        {pinned ? <PinOffIcon /> : <PinIcon />}
                    </button>
                )}
            </div>
        </li>
    );
}

interface SectionProps {
    readonly section: SidebarSection;
    readonly open: boolean;
    readonly rows: readonly VisibleRow[];
    readonly expanded: ReadonlySet<string>;
    readonly pins: readonly string[];
    readonly now: number;
    readonly onToggleSection: (key: string) => void;
    readonly onToggleFold: (id: string) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, id: string) => void;
}

function Section({ section, open, rows, expanded, pins, now, onToggleSection, onToggleFold, onKeyDown }: SectionProps) {
    const { route, navigate } = useRouter();
    const active = route.kind === "workspace" && section.kind === "folder" && route.folder === section.workspace;
    const heading = section.title !== "" && !section.folderRow;
    return (
        <section className="session-group" data-group={section.key} data-workspace={section.workspace} data-open={open} data-heading={heading ? "true" : "false"}>
            {!heading ? null : section.kind === "pinned" ? (
                <div className="group-head" data-kind="pinned">
                    <span className="group-title" data-kind="pinned">{section.title}</span>
                </div>
            ) : section.kind === "folder" ? (
                <div className="group-head" data-kind="folder">
                    <FolderIcon className="group-folder-icon" />
                    <button
                        type="button"
                        className="group-title"
                        data-kind="folder"
                        title={`Open ${section.workspace}`}
                        data-active={active}
                        aria-current={active ? "page" : undefined}
                        onClick={() => navigate({ kind: "workspace", folder: section.workspace })}
                    >
                        {section.title}
                    </button>
                </div>
            ) : (
                <div className="group-head" data-kind={section.kind}>
                    <button
                        type="button"
                        className="group-disclose"
                        aria-label={open ? `Collapse ${section.title}` : `Expand ${section.title}`}
                        aria-expanded={open}
                        onClick={() => onToggleSection(section.key)}
                    >
                        <ChevronRightIcon className="group-chevron" />
                    </button>
                    <button
                        type="button"
                        className="group-title"
                        onClick={() => onToggleSection(section.key)}
                    >
                        {section.title}
                    </button>
                </div>
            )}
            {open ? (
                <ul className="session-list">
                    {rows.map(({ node, depth, root, headed, guides, last }) => (
                        <Row
                            key={node.row.id}
                            row={node.row}
                            archiveRoot={node.archiveRoot}
                            depth={depth}
                            root={root}
                            headed={headed}
                            guides={guides}
                            last={last}
                            folderRow={section.folderRow && root}
                            pinned={pins.includes(node.row.id)}
                            open={expanded.has(node.row.id)}
                            childCount={node.children.length}
                            now={now}
                            onToggleFold={onToggleFold}
                            onKeyDown={onKeyDown}
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
    const grouping = useSidebarGrouping();
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(() => new Set([ARCHIVED_KEY]));
    const listRef = useRef<HTMLDivElement>(null);
    const rows = state.sessionRows;
    useEffect(() => {
        if (rows === undefined) return;
        const ids = new Set(rows.map((row) => row.id));
        setExpanded((current) => {
            const kept = [...current].filter((id) => ids.has(id));
            return kept.length === current.size ? current : new Set(kept);
        });
        // A section that leaves the list starts collapsed when it returns.
        if (!rows.some((row) => row.archived === true)) {
            setClosedSections((current) => current.has(ARCHIVED_KEY) ? current : new Set(current).add(ARCHIVED_KEY));
        }
    }, [rows]);
    useEffect(() => {
        const id = takePinFocus();
        if (id === undefined) return;
        const target = listRef.current === null
            ? undefined
            : [...listRef.current.querySelectorAll<HTMLElement>("[data-pin]")].find((element) => element.dataset.pin === id);
        target?.focus();
    }, [pins]);
    if (state.phase !== "attached" || rows === undefined) {
        return <p className="view-empty">{state.phase === "attached" ? "Loading sessions." : "Not connected to the host."}</p>;
    }
    if (rows.length === 0) return <p className="view-empty">No sessions in this home yet.</p>;
    const now = Date.now();
    const total = state.sessions;
    const tree = buildSidebarTree(rows, pins, grouping);
    const sectionOpen = (section: SidebarSection): boolean => section.kind === "pinned"
        || section.kind === "flat"
        || section.kind === "folder"
        || section.folderRow
        || !closedSections.has(section.key);
    const shown = tree.sections.map((section) => ({
        section,
        open: sectionOpen(section),
        rows: sectionOpen(section) ? visibleRows(section, expanded) : [],
    }));
    const visibleFlat = shown.flatMap((entry) => entry.rows);
    const toggleFold = (id: string): void => setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
    });
    const toggleSection = (key: string): void => setClosedSections((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
    });
    const focusRow = (id: string): void => {
        const target = listRef.current === null
            ? undefined
            : [...listRef.current.querySelectorAll<HTMLElement>("[data-session]")].find((element) => element.dataset.session === id);
        target?.focus();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string): void => {
        const index = visibleFlat.findIndex((entry) => entry.node.row.id === id);
        const here = visibleFlat[index];
        if (here === undefined) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const next = visibleFlat[index + (event.key === "ArrowDown" ? 1 : -1)];
            if (next === undefined) return;
            event.preventDefault();
            focusRow(next.node.row.id);
            return;
        }
        if (event.key === "ArrowRight") {
            if (here.node.children.length === 0) return;
            event.preventDefault();
            if (!expanded.has(id)) toggleFold(id);
            else focusRow(here.node.children[0]!.row.id);
            return;
        }
        if (event.key === "ArrowLeft") {
            if (here.node.children.length > 0 && expanded.has(id)) {
                event.preventDefault();
                toggleFold(id);
                return;
            }
            if (here.parentId === undefined) return;
            event.preventDefault();
            focusRow(here.parentId);
        }
    };
    return (
        <div className="sessions-view" ref={listRef} data-motion-visible={visible && windowShown && documentShown} data-grouping={grouping}>
            {shown.map(({ section, open, rows: sectionRows }) => (
                <Section
                    key={section.key}
                    section={section}
                    open={open}
                    rows={sectionRows}
                    expanded={expanded}
                    pins={pins}
                    now={now}
                    onToggleSection={toggleSection}
                    onToggleFold={toggleFold}
                    onKeyDown={onKeyDown}
                />
            ))}
            {total !== undefined && total > rows.length ? (
                <p className="view-note">Showing the latest {rows.length} of {total}.</p>
            ) : null}
        </div>
    );
}
