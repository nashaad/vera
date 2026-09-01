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

/** The workspace side bar's presentation model, with no OpenTUI in it. `workspace-panel.ts` decides rows, order and markers. */

export const WORKSPACE_JUMP_ROWS = 9;
export const WORKSPACE_JUMPS_ENABLED = false;
export const WORKSPACE_SELECTION_MARKER = "›";

export const WORKSPACE_RECENT_IDLE = 5;

export const WORKSPACE_HEADER_ALL_ACTION = "workspace:all-sessions";
export const WORKSPACE_HEADER_NEW_ACTION = "workspace:new-session";

export function workspaceHeaderAction(
    id: string,
): WorkspaceSidebarAction | undefined {
    if (id === WORKSPACE_HEADER_ALL_ACTION) return { kind: "resume_picker" };
    if (id === WORKSPACE_HEADER_NEW_ACTION) return { kind: "new_session" };
    return undefined;
}

export const WORKSPACE_EMPTY_LINES: readonly string[] = [
    "No sessions yet.",
    "ctrl+n new session",
    "ctrl+r all sessions",
];

const ROW_PREFIX_COLUMNS = 2;
const RAIL_DIVIDER_COLUMNS = 1;
const AGE_WITH_GAP_COLUMNS = 9;
const MIN_TITLE_WITH_AGE_COLUMNS = 8;
export const MIN_RAIL_COLUMNS = 28;
const MIN_CHAT_COLUMNS = 35;

export function workspaceRailColumns(
    columns: number,
    preferred?: number,
): number | undefined {
    const width = workspacePanelWidth(columns);
    if (width === "narrow") return undefined;
    const natural = workspaceRowColumns(width);
    return clampWorkspaceRailColumns(preferred ?? natural, columns);
}

export function clampWorkspaceRailColumns(
    requested: number,
    columns: number,
): number | undefined {
    if (workspacePanelWidth(columns) === "narrow") return undefined;
    const maximum = Math.max(MIN_RAIL_COLUMNS, columns - MIN_CHAT_COLUMNS - 2);
    return Math.min(Math.max(Math.round(requested), MIN_RAIL_COLUMNS), maximum);
}

export interface WorkspaceSidebarSession extends WorkspaceSession {
    readonly sessionPath: string;
    readonly workerPid?: number;
}

export interface WorkspaceSidebarState {
    readonly sessions: readonly WorkspaceSidebarSession[];
    readonly pinnedIds: readonly string[];
    readonly selectedId?: string;
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
        readonly active: boolean;
    }
    | { readonly kind: "pin"; readonly pinnedIds: readonly string[] };

export interface WorkspaceSidebarTransition {
    readonly state?: WorkspaceSidebarState;
    readonly action?: WorkspaceSidebarAction;
    readonly handled: boolean;
}

export function workspaceSidebarSessions(
    agents: readonly RegisteredAgentSummary[],
): readonly WorkspaceSidebarSession[] {
    return agents
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

export function isWorkspaceActive(session: WorkspaceSidebarSession): boolean {
    return session.live
        || session.status === "waiting"
        || session.status === "working"
        || session.workerPid !== undefined;
}

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

export function workIndexStatus(
    index: WorkIndexSnapshot,
    sessionId: string,
): WorkspaceSessionStatus | undefined {
    const row = index.rows.find((candidate) => candidate.session_id === sessionId);
    if (row === undefined) return undefined;
    if (row.reason === "failure") return "failed";
    if (row.section === "needs_you") return "waiting";
    if (row.section === "working") return "working";
    if (row.section === "done_recently") return "completed";
    if (row.section === "ready_to_review") return "completed";
    return "idle";
}

export function refreshWorkspaceSidebarSessions(
    state: WorkspaceSidebarState,
    sessions: readonly WorkspaceSidebarSession[],
): WorkspaceSidebarState {
    return { ...state, sessions };
}

export function applyWorkspaceWorkIndex(
    state: WorkspaceSidebarState,
    index: WorkIndexSnapshot,
): WorkspaceSidebarState {
    return {
        ...state,
        sessions: state.sessions.map((session) => {
            // The roster owns terminal lifecycle. The work index calls a non-actionable failure a completed item because its job is to organize attention; that must not repaint a failed.
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
        isActive: (session) =>
            isWorkspaceActive(session as WorkspaceSidebarSession),
    });
}

export function workspaceJumpTargets(
    layout: WorkspacePanelLayout,
): readonly string[] {
    return layout.rows
        .filter((row) => row.kind === "session" && row.active)
        .map((row) => (row as { id: string }).id)
        .slice(0, WORKSPACE_JUMP_ROWS);
}

export function workspaceJumpTarget(
    layout: WorkspacePanelLayout,
    position: number,
): string | undefined {
    if (position < 1 || position > WORKSPACE_JUMP_ROWS) return undefined;
    return workspaceJumpTargets(layout)[position - 1];
}

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

export function handleWorkspaceSidebarKey(
    state: WorkspaceSidebarState,
    key: WorkspaceSidebarKey,
    now: Date,
    columns: number,
    viewportRows?: number,
): WorkspaceSidebarTransition {
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
    return { state, handled: true };
}

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

export function workspaceSidebarText(
    state: WorkspaceSidebarState,
    width: number,
    now: Date = new Date(),
): string {
    return workspaceSidebarViewState(state, width, now)
        .lines.map((line) => line.text).join("\n");
}
