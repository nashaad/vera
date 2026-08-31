import type { LinesViewFooterRow, LinesViewState } from "./lines-view.ts";
import { halfPageCursor } from "./list-window.ts";
import {
    layoutWorkspacePanel,
    moveWorkspaceSelection,
    WORKSPACE_COMPLETED_MARKER,
    WORKSPACE_PINS_ENABLED,
    workspacePanelWidth,
    workspaceRowColumns,
    type WorkspacePanelLayout,
    type WorkspaceSession,
    type WorkspaceSessionStatus,
} from "./workspace-panel.ts";
import { tuiBindingId, tuiKeyChord } from "./keymap.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";

/**
 * The workspace side bar's presentation model, with no OpenTUI in it.
 *
 * `workspace-panel.ts` decides rows, order and markers. This module holds the
 * little that a drawn side bar adds: which row the cursor is on, dormant jump
 * and pin behavior, and the lines the shared card mounts.
 */

/** Rows the dormant digit-target algorithm retains. */
export const WORKSPACE_JUMP_ROWS = 9;
/**
 * Number jumps are dormant while their global interaction is designed.
 *
 * Keep the bindings, target calculation, and focused-pane handler intact. If
 * they return, the shortcut should work from chat, file view, or a hidden rail
 * rather than requiring the user to focus the sidebar first.
 */
export const WORKSPACE_JUMPS_ENABLED = false;
/** Text-readable cursor/current mark, appended so row titles stay flush-left. */
export const WORKSPACE_SELECTION_MARKER = "›";

/**
 * Idle jsonl rows kept in the rail, newest first.
 *
 * Live sessions have no cap. Older idle history stays in `/resume`. The
 * session on screen and any pin are always kept, even when they are idle.
 */
export const WORKSPACE_RECENT_IDLE = 5;

/** Text-safe controls at the right edge of the branded rail header. */
export const WORKSPACE_HEADER_ALL_ACTION = "workspace:all-sessions";
export const WORKSPACE_HEADER_NEW_ACTION = "workspace:new-session";

/** Resolves a header hit without letting its synthetic id become a row id. */
export function workspaceHeaderAction(
    id: string,
): WorkspaceSidebarAction | undefined {
    if (id === WORKSPACE_HEADER_ALL_ACTION) return { kind: "resume_picker" };
    if (id === WORKSPACE_HEADER_NEW_ACTION) return { kind: "new_session" };
    return undefined;
}

/** What the rail says when there is nothing to list. */
export const WORKSPACE_EMPTY_LINES: readonly string[] = [
    "No sessions yet.",
    "ctrl+n new session",
    "ctrl+r all sessions",
];

/** Status glyph and the space before every title. */
const ROW_PREFIX_COLUMNS = 2;
/** The divider occupies the rail's final rendered cell. */
const RAIL_DIVIDER_COLUMNS = 1;
/** Eight age columns plus the space before them. */
const AGE_WITH_GAP_COLUMNS = 9;
/** Keep a readable title before preserving age in a squeezed rail. */
const MIN_TITLE_WITH_AGE_COLUMNS = 8;
/** Narrowest useful rail; titles truncate after their markers when narrower. */
export const MIN_RAIL_COLUMNS = 28;
/** The conversation stays useful while the explorer is resized. */
const MIN_CHAT_COLUMNS = 35;

/**
 * The columns a row needs when the listing is drawn beside the transcript, or
 * nothing at the width where there is no room for two columns.
 *
 * Wide enough for the longest row the listing can draw, so the answer is the
 * same for every listing and the transcript beside it does not reflow as
 * sessions come and go. The surface adds its own padding to this.
 */
export function workspaceRailColumns(
    columns: number,
    preferred?: number,
): number | undefined {
    const width = workspacePanelWidth(columns);
    if (width === "narrow") return undefined;
    const natural = workspaceRowColumns(width);
    return clampWorkspaceRailColumns(preferred ?? natural, columns);
}

/** A dragged rail cannot consume the conversation or become unreadable. */
export function clampWorkspaceRailColumns(
    requested: number,
    columns: number,
): number | undefined {
    if (workspacePanelWidth(columns) === "narrow") return undefined;
    const maximum = Math.max(MIN_RAIL_COLUMNS, columns - MIN_CHAT_COLUMNS - 2);
    return Math.min(Math.max(Math.round(requested), MIN_RAIL_COLUMNS), maximum);
}

/**
 * A listed session plus where its transcript lives.
 *
 * Opening uses this row's own facts, not a second listing: looking it up
 * again afterwards could name a session the row no longer describes, or
 * treat a timeout as "already running" and start a worker.
 */
export interface WorkspaceSidebarSession extends WorkspaceSession {
    readonly sessionPath: string;
    /** Live process hosting this session, when the listing named one. */
    readonly workerPid?: number;
}

export interface WorkspaceSidebarState {
    readonly sessions: readonly WorkspaceSidebarSession[];
    readonly pinnedIds: readonly string[];
    readonly selectedId?: string;
    /** The session on screen, marked so the list says where you already are. */
    readonly currentId?: string;
}

export type WorkspaceSidebarAction =
    | { readonly kind: "close" }
    | { readonly kind: "hide" }
    | { readonly kind: "new_session" }
    | { readonly kind: "resume_picker" }
    | {
        readonly kind: "rename_session";
        readonly session_id: string;
        readonly label: string;
        readonly value?: string;
    }
    | {
        readonly kind: "open_session";
        readonly session_id: string;
        readonly session_path: string;
        /** Attach to a running worker; otherwise paint the session file. */
        readonly active: boolean;
    }
    | { readonly kind: "pin"; readonly pinnedIds: readonly string[] };

export interface WorkspaceSidebarTransition {
    readonly state?: WorkspaceSidebarState;
    readonly action?: WorkspaceSidebarAction;
    readonly handled: boolean;
}

/** The registry listing as this view needs it. */
export function workspaceSidebarSessions(
    agents: readonly RegisteredAgentSummary[],
): readonly WorkspaceSidebarSession[] {
    return agents
        // A header-only transcript is an implementation shell, not workspace
        // history. Keep it while live so a running or attached session remains
        // reachable; keep an unknown value for compatibility with older hosts.
        .filter((agent) => agent.has_user_content !== false || agent.live)
        .map((agent) => ({
            id: agent.id,
            workspace: agent.workspace,
            sessionPath: agent.session_path,
            kind: agent.kind,
            status: agent.status,
            live: agent.live,
            ...(agent.title === undefined ? {} : { title: agent.title }),
            ...(agent.updated_at === undefined
                ? {}
                : { updatedAt: agent.updated_at }),
            ...(agent.worker_pid === undefined
                ? {}
                : { workerPid: agent.worker_pid }),
        }));
}

/**
 * Whether a listed session is live work, not idle jsonl.
 *
 * `live` is the host's fact. Waiting, working, and a named worker are kept
 * even if that flag flickers, so a needs-you row cannot vanish from the rail
 * and a parked worker is an attach rather than a file view.
 */
export function isWorkspaceActive(session: WorkspaceSidebarSession): boolean {
    return session.live
        || session.status === "waiting"
        || session.status === "working"
        || session.workerPid !== undefined;
}

/**
 * The rows the agent sidebar draws from a roster.
 *
 * Live sessions are the working set and have no cap. Idle jsonl rows keep
 * the last few by recency. The session on screen and pinned rows are always
 * kept, even when they are idle, and they do not consume a recents slot: the
 * five are besides those rows, so a second project's idle chat does not
 * vanish when you look at one that already made the cut.
 */
export function workspaceWorkingSet(
    sessions: readonly WorkspaceSidebarSession[],
    currentId?: string,
    pinnedIds: readonly string[] = [],
): readonly WorkspaceSidebarSession[] {
    const pinned = new Set(WORKSPACE_PINS_ENABLED ? pinnedIds : []);
    const kept = new Set<string>();
    for (const session of sessions) {
        if (
            isWorkspaceActive(session)
            || session.id === currentId
            || pinned.has(session.id)
        ) {
            kept.add(session.id);
        }
    }
    const recentIdle = new Set(
        sessions
            .filter((session) => !kept.has(session.id))
            .slice()
            .sort(byIdleRecency)
            .slice(0, WORKSPACE_RECENT_IDLE)
            .map((session) => session.id),
    );
    return sessions.filter((session) =>
        kept.has(session.id) || recentIdle.has(session.id)
    );
}

/**
 * The next or previous live session in rail order, or nothing when there is
 * nowhere to go.
 *
 * Live means a worker is up: working, waiting, attached-idle, or a named
 * pid. Parked jsonl rows are skipped. Looking at one of those still lands
 * on a live neighbour. One live session that is already on screen is a
 * no-op.
 */
export function workspaceCycleTarget(
    state: WorkspaceSidebarState,
    direction: 1 | -1,
    now: Date,
    columns: number,
): WorkspaceSidebarSession | undefined {
    const layout = workspaceSidebarLayout(state, { columns, now });
    const activeIds = layout.selectable.filter((id) => {
        const session = state.sessions.find((candidate) => candidate.id === id);
        return session !== undefined && isWorkspaceActive(session);
    });
    if (activeIds.length === 0) return undefined;
    const current = state.currentId;
    const at = current === undefined ? -1 : activeIds.indexOf(current);
    const nextIndex = at === -1
        ? (direction === 1 ? 0 : activeIds.length - 1)
        : (at + direction + activeIds.length) % activeIds.length;
    const nextId = activeIds[nextIndex];
    if (nextId === undefined || nextId === current) return undefined;
    return state.sessions.find((session) => session.id === nextId);
}

function byIdleRecency(
    left: WorkspaceSidebarSession,
    right: WorkspaceSidebarSession,
): number {
    const difference = idleTimestamp(right.updatedAt)
        - idleTimestamp(left.updatedAt);
    return difference === 0 ? left.id.localeCompare(right.id) : difference;
}

function idleTimestamp(value: string | undefined): number {
    if (value === undefined) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

export function startWorkspaceSidebar(
    sessions: readonly WorkspaceSidebarSession[],
    pinnedIds: readonly string[],
    currentId?: string,
): WorkspaceSidebarState {
    return {
        sessions,
        pinnedIds,
        ...(currentId === undefined ? {} : { currentId, selectedId: currentId }),
    };
}

/**
 * The status a pushed work index gives a session, or nothing when it says
 * nothing about it.
 *
 * The index is the only status channel the side bar has, and it is pushed on
 * every roster transition whether or not anyone is attached. Nothing here polls
 * and nothing here adds a field to the wire.
 */
export function workIndexStatus(
    index: WorkIndexSnapshot,
    sessionId: string,
): WorkspaceSessionStatus | undefined {
    const row = index.rows.find((candidate) => candidate.session_id === sessionId);
    if (row === undefined) return undefined;
    if (row.reason === "failure") return "failed";
    if (row.section === "needs_you") return "waiting";
    if (row.section === "working") return "working";
    // Both of the finished sections read as completed: the work in them is
    // over, and what separates them is whether anyone has looked yet.
    if (row.section === "done_recently") return "completed";
    if (row.section === "ready_to_review") return "completed";
    return "idle";
}

/**
 * A re-read roster, folded onto the pane already open.
 *
 * The listing is read again on the same push that carries status, because that
 * push fires on the transition that changes the roster: a session created while
 * the pane is open is in the new listing and was not in the old one. Selection
 * and pins are the reader's and survive the re-read; a selected session that
 * has gone away is resolved by the layout, on the same rule as any other row
 * that leaves the listing.
 */
export function refreshWorkspaceSidebarSessions(
    state: WorkspaceSidebarState,
    sessions: readonly WorkspaceSidebarSession[],
): WorkspaceSidebarState {
    return { ...state, sessions };
}

/** A fresh index from the host, folded onto the rows already listed. */
export function applyWorkspaceWorkIndex(
    state: WorkspaceSidebarState,
    index: WorkIndexSnapshot,
): WorkspaceSidebarState {
    return {
        ...state,
        sessions: state.sessions.map((session) => {
            // The roster owns terminal lifecycle. The work index calls a
            // non-actionable failure a completed item because its job is to
            // organize attention; that must not repaint a failed session as
            // successful in the workspace navigator.
            const status = session.status === "failed"
                    || session.status === "closed"
                ? session.status
                : workIndexStatus(index, session.id);
            const row = index.rows.find(
                (candidate) => candidate.session_id === session.id,
            );
            if (status === undefined) return session;
            return {
                ...session,
                status,
                ...(row === undefined ? {} : { updatedAt: row.updated_at }),
            };
        }),
    };
}

export interface WorkspaceSidebarLayoutInput {
    readonly columns: number;
    readonly now: Date;
    readonly contentColumns?: number;
    readonly showAge?: boolean;
    readonly animationFrame?: number;
}

export function workspaceSidebarLayout(
    state: WorkspaceSidebarState,
    input: WorkspaceSidebarLayoutInput,
): WorkspacePanelLayout {
    return layoutWorkspacePanel({
        sessions: workspaceWorkingSet(
            state.sessions,
            state.currentId,
            state.pinnedIds,
        ),
        columns: input.columns,
        now: input.now,
        ...(input.contentColumns === undefined
            ? {}
            : { contentColumns: input.contentColumns }),
        ...(input.showAge === undefined ? {} : { showAge: input.showAge }),
        ...(input.animationFrame === undefined
            ? {}
            : { animationFrame: input.animationFrame }),
        pinnedIds: state.pinnedIds,
        ...(state.selectedId === undefined
            ? {}
            : { selectedId: state.selectedId }),
        ...(state.currentId === undefined ? {} : { currentId: state.currentId }),
        // Being on screen is not activity. A session file is read from disk
        // with no worker behind it, so the row for the one being read belongs
        // under recent like every other file, and no digit addresses it.
        isActive: (session) =>
            isWorkspaceActive(session as WorkspaceSidebarSession),
    });
}

/** Digits address active rows only, counting from the top of the listing. */
export function workspaceJumpTargets(
    layout: WorkspacePanelLayout,
): readonly string[] {
    return layout.rows
        .filter((row) => row.kind === "session" && row.active)
        .map((row) => (row as { id: string }).id)
        .slice(0, WORKSPACE_JUMP_ROWS);
}

/** The session a digit addresses, or nothing past the end of the listing. */
export function workspaceJumpTarget(
    layout: WorkspacePanelLayout,
    position: number,
): string | undefined {
    if (position < 1 || position > WORKSPACE_JUMP_ROWS) return undefined;
    return workspaceJumpTargets(layout)[position - 1];
}

/** The pin list after toggling one session, order preserved. */
export function toggleWorkspacePin(
    pinnedIds: readonly string[],
    sessionId: string,
): readonly string[] {
    return pinnedIds.includes(sessionId)
        ? pinnedIds.filter((id) => id !== sessionId)
        : [...pinnedIds, sessionId];
}

export interface WorkspaceSidebarKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

/**
 * Arrows or j/k move one row, ctrl+d / ctrl+u jump half a page, enter opens,
 * r renames the selected row, ctrl+r opens the full resume picker, and ctrl+n
 * starts a new chat while keeping this one running. Dormant digit handling
 * remains below for a future global jump interaction.
 * None of the movement keys switch the viewed session.
 *
 * Every chord this does not claim is passed back unhandled, which is what lets
 * ctrl+e close the pane it opened and ctrl+c reach the client from inside it.
 */
export function handleWorkspaceSidebarKey(
    state: WorkspaceSidebarState,
    key: WorkspaceSidebarKey,
    now: Date,
    columns: number,
    viewportRows?: number,
): WorkspaceSidebarTransition {
    // Half-page movement, ahead of the modifier bail-out below. The cursor
    // travels with the jump rather than the window sliding out from under it,
    // so ctrl+d is ↓ held down and nothing new has to be learned about where
    // the highlight went. The chords are the picker's half-page ids, inherited
    // into this scope, so remapping one list movement remaps both.
    const binding = tuiBindingId("workspace", key);
    if (binding === "half_page_down" || binding === "half_page_up") {
        const layout = workspaceSidebarLayout(state, { columns, now });
        const selectable = layout.selectable;
        if (selectable.length === 0) return { state, handled: true };
        const current = layout.selectedId === undefined
            ? 0
            : Math.max(0, selectable.indexOf(layout.selectedId));
        const selectedId = selectable[halfPageCursor(
            current,
            selectable.length,
            viewportRows ?? 10,
            binding === "half_page_down" ? "down" : "up",
        )];
        return {
            state: selectedId === undefined ? state : { ...state, selectedId },
            handled: true,
        };
    }
    if (binding === "workspace_new_session") {
        return { action: { kind: "new_session" }, handled: true };
    }
    if (binding === "workspace_resume_picker") {
        return { action: { kind: "resume_picker" }, handled: true };
    }
    if (binding === "workspace_rename_session") {
        const layout = workspaceSidebarLayout(state, { columns, now });
        const row = layout.rows.find(
            (candidate) => candidate.kind === "session"
                && candidate.id === layout.selectedId,
        );
        const session = state.sessions.find(
            (candidate) => candidate.id === layout.selectedId,
        );
        return row === undefined || row.kind !== "session"
            ? { state, handled: true }
            : {
                action: {
                    kind: "rename_session",
                    session_id: row.id,
                    label: row.title,
                    ...(session?.title === undefined
                        ? {}
                        : { value: session.title }),
                },
                handled: true,
            };
    }
    if (key.ctrl || key.meta) return { state, handled: false };
    const layout = workspaceSidebarLayout(state, { columns, now });
    if (key.name === "escape") {
        return { action: { kind: "hide" }, handled: true };
    }
    if (tuiBindingId("unfocused", key) === "focus_composer") {
        return { action: { kind: "close" }, handled: true };
    }
    if (
        key.name === "up" || key.name === "down"
        || key.name === "j" || key.name === "k"
    ) {
        const selectedId = moveWorkspaceSelection(
            layout,
            key.name === "up" || key.name === "k" ? -1 : 1,
        );
        return {
            state: selectedId === undefined ? state : { ...state, selectedId },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const action = openWorkspaceSelection(state, layout.selectedId);
        return action === undefined
            ? { state, handled: true }
            : { action, handled: true };
    }
    if (
        WORKSPACE_PINS_ENABLED
        && tuiBindingId("workspace", key) === "toggle_workspace_pin"
    ) {
        const selectedId = layout.selectedId;
        if (selectedId === undefined) return { state, handled: true };
        const pinnedIds = toggleWorkspacePin(state.pinnedIds, selectedId);
        return {
            state: { ...state, pinnedIds },
            action: { kind: "pin", pinnedIds },
            handled: true,
        };
    }
    if (
        WORKSPACE_JUMPS_ENABLED
        && binding !== undefined
        && binding.startsWith("workspace_jump_")
    ) {
        const position = Number(binding.slice("workspace_jump_".length));
        const target = workspaceJumpTarget(layout, position);
        if (target === undefined) return { state, handled: true };
        const action = openWorkspaceSelection(state, target);
        return action === undefined
            ? { state, handled: true }
            : { action, handled: true };
    }
    // A bare key belongs to the focused pane even when the pane has nothing to
    // do with it, or it would reach the surface behind. Chords carry a
    // modifier and are passed back, which is what lets ctrl+e close the pane
    // that ctrl+e opened and ctrl+c reach the client from inside it.
    return { state, handled: true };
}

/** What activating a row means. Enter or a click switches the viewed session; moving the highlight does not. */
export function openWorkspaceSelection(
    state: WorkspaceSidebarState,
    sessionId: string | undefined,
): WorkspaceSidebarAction | undefined {
    const session = state.sessions.find(
        (candidate) => candidate.id === sessionId,
    );
    if (session === undefined) return undefined;
    return {
        kind: "open_session",
        session_id: session.id,
        session_path: session.sessionPath,
        active: isWorkspaceActive(session),
    };
}

/** The wordmark at the head of the rail. */
export const WORKSPACE_SIDEBAR_WORDMARK = "VERA";

export function workspaceSidebarHeader(state: WorkspaceSidebarState): string {
    const listed = workspaceWorkingSet(
        state.sessions,
        state.currentId,
        state.pinnedIds,
    ).length;
    return listed === 0
        ? WORKSPACE_SIDEBAR_WORDMARK
        : `${WORKSPACE_SIDEBAR_WORDMARK} · ${listed}`;
}

/**
 * The footer hint, in the pickers' shape.
 *
 * Drawn in full only while the rail holds the keyboard. Most of these chords
 * are the rail's own, and beside a conversation a block the glance cannot use
 * reads as instructions for the screen it sits next to.
 */
export function workspaceSidebarFooterTable(): readonly LinesViewFooterRow[] {
    return [
        { label: "Move", value: "↑↓  j/k" },
        { label: "Page", value: "ctrl+d/u" },
        { label: "Open", value: "enter" },
        { label: "Rename", value: tuiKeyChord("workspace_rename_session") },
        ...(WORKSPACE_JUMPS_ENABLED ? [{ label: "Jump", value: "1–9" }] : []),
        ...(WORKSPACE_PINS_ENABLED ? [{ label: "Pin", value: "p" }] : []),
        { label: "New", value: "ctrl+n" },
        { label: "Resume", value: "ctrl+r" },
        { label: "Cycle", value: "ctrl+shift+[ ]" },
        { label: "Chat", value: "→" },
        { label: "Hide", value: "ctrl+e" },
    ];
}

/**
 * What the rail says while the keyboard is in the conversation beside it.
 *
 * The chords that answer from there: the live session cycle, which is global,
 * the one that hands the rail the keys, and the one that puts it away.
 */
export const WORKSPACE_QUIET_FOOTER_TABLE: readonly LinesViewFooterRow[] = [
    { label: "Cycle", value: "ctrl+shift+[ ]" },
    { label: "Focus", value: "←" },
    { label: "Hide", value: "ctrl+e" },
];

export function workspaceSidebarFooter(
    _width: number,
    table: readonly LinesViewFooterRow[] = workspaceSidebarFooterTable(),
): string {
    const labelWidth = Math.max(
        ...table.map((row) => row.label.length + 2),
    );
    return table
        .map((row) => `${row.label.padEnd(labelWidth)}${row.value}`)
        .join("\n");
}

/**
 * The side bar as the shared card draws it.
 *
 * `columns` is the terminal's width, not the surface's: it decides whether the
 * listing is a rail or a card, and the rail is narrower than the terminal that
 * earns it. The footer is measured against whichever of the two is drawn.
 */
export function workspaceSidebarViewState(
    state: WorkspaceSidebarState,
    columns: number,
    now: Date = new Date(),
    railColumns = workspaceRailColumns(columns),
    focused = false,
    animationFrame = 0,
): LinesViewState {
    const railContentColumns = railColumns === undefined
        ? undefined
        : Math.max(
            1,
            railColumns - ROW_PREFIX_COLUMNS - RAIL_DIVIDER_COLUMNS,
        );
    const layout = workspaceSidebarLayout(state, {
        columns,
        now,
        animationFrame,
        ...(railContentColumns === undefined
            ? {}
            : {
                contentColumns: railContentColumns,
                showAge: railContentColumns
                    >= AGE_WITH_GAP_COLUMNS + MIN_TITLE_WITH_AGE_COLUMNS,
            }),
    });
    const width = railColumns ?? columns;
    const rowColumns = railColumns === undefined
        ? workspaceRowColumns(layout.width)
        : railColumns - RAIL_DIVIDER_COLUMNS;
    let position = 0;
    const lines: LinesViewState["lines"][number][] = [];
    for (const text of layout.rows.length === 0 ? WORKSPACE_EMPTY_LINES : []) {
        lines.push({ text, tone: "muted" as const });
    }
    let seenGroup = false;
    const rowTone = focused ? "text" as const : "muted" as const;
    for (const row of layout.rows) {
        if (row.kind === "group") {
            if (seenGroup) {
                lines.push({ text: "", tone: "muted" as const });
            }
            seenGroup = true;
            lines.push({
                text: row.text,
                tone: focused ? "heading" as const : "muted" as const,
            });
            continue;
        }
        // The digit is drawn on the active row it addresses. Positional and
        // churning as the list reorders, which is why it is a shortcut and not
        // the way a row is picked. Idle rows carry none.
        if (WORKSPACE_JUMPS_ENABLED && row.active) position += 1;
        const showDigit = WORKSPACE_JUMPS_ENABLED
            && row.active
            && position <= WORKSPACE_JUMP_ROWS;
        const digit = showDigit ? `${position}` : " ";
        const trailing = row.active
            ? [row.detail, digit.trim()].filter((value) => value.length > 0)
                .join(" · ")
            : row.detail;
        const selectedText = row.selected
            ? `${row.text} ${WORKSPACE_SELECTION_MARKER}`
            : row.text;
        lines.push({
            text: rightAlignedRow(selectedText, trailing, rowColumns),
            tone: rowTone,
            rowId: row.id,
            ...(row.marker === WORKSPACE_COMPLETED_MARKER
                ? {
                    leading: {
                        text: WORKSPACE_COMPLETED_MARKER,
                        tone: "positive" as const,
                    },
                }
                : {}),
            // The background helps while the rail owns the keyboard. The
            // suffix above remains in plain-text captures and while chat has
            // focus, without adding the empty left gutter this layout removed.
            ...(row.selected ? { selected: true } : {}),
        });
    }
    const cursorLine = lines.findIndex((line) =>
        line.rowId !== undefined && line.rowId === layout.selectedId
    );
    const footerTable = focused
        ? workspaceSidebarFooterTable()
        : WORKSPACE_QUIET_FOOTER_TABLE;
    return {
        // The wordmark is what the rail is called, so it says the same thing
        // whichever side holds the keyboard. Focus accents the wordmark, the
        // rule under it, and the edge beside it without moving the title.
        title: workspaceSidebarHeader(state),
        titleLeading: {
            text: WORKSPACE_SIDEBAR_WORDMARK,
            tone: "accent",
        },
        headerActions: [
            { id: WORKSPACE_HEADER_ALL_ACTION, text: "≡" },
            { id: WORKSPACE_HEADER_NEW_ACTION, text: "+" },
        ],
        ...(focused ? { focused: true } : {}),
        // The rail's footer already names esc. The chip on the title is
        // dialog chrome and crowds a 28-column column.
        ...(railColumns === undefined ? {} : { hint: "" }),
        ...(cursorLine === -1 ? {} : { cursorLine }),
        lines,
        footer: workspaceSidebarFooter(width, footerTable),
        footerTable,
        ...(focused ? {} : { dimmed: true }),
    };
}

function rightAlignedRow(
    left: string,
    right: string,
    columns: number,
): string {
    if (right.length === 0) return clipRow(left, columns);
    const leftColumns = Math.max(1, columns - right.length - 1);
    const shown = clipRow(left, leftColumns);
    const gap = Math.max(1, columns - shown.length - right.length);
    return `${shown}${" ".repeat(gap)}${right}`;
}

function clipRow(text: string, columns: number): string {
    if (text.length <= columns) return text;
    if (columns <= 1) return text.slice(0, columns);
    return `${text.slice(0, columns - 1)}…`;
}

/** The lines as one block of text, for the headless renderer and for tests. */
export function workspaceSidebarText(
    state: WorkspaceSidebarState,
    width: number,
    now: Date = new Date(),
): string {
    return workspaceSidebarViewState(state, width, now)
        .lines.map((line) => line.text).join("\n");
}
