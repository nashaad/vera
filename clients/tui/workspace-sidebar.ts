import { importedSessionLabel } from "../../src/store/session-import-provenance.ts";
import { tuiKeyChordLabel } from "./keymap.ts";
import type { LinesViewFooterRow, LinesViewState } from "./lines-view.ts";
import {
    layoutWorkspacePanel,
    WORKSPACE_COMPLETED_MARKER,
    workspacePanelWidth,
    workspaceRowColumns,
    type WorkspacePanelLayout,
    type WorkspaceSession,
    type WorkspaceSessionStatus,
} from "./workspace-panel.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";

/** The workspace side bar's presentation model, with no OpenTUI in it. `workspace-panel.ts` decides rows, order and markers. */

export const WORKSPACE_EMPTY_LINES: readonly string[] = [
    "Nothing running.",
];

const ROW_PREFIX_COLUMNS = 2;
const RAIL_DIVIDER_COLUMNS = 1;
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

export interface WorkspaceSidebarAction {
    readonly kind: "open_session";
    readonly session_id: string;
    readonly session_path: string;
    readonly active: boolean;
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
            ...(agent.imported_from === undefined
                ? {}
                : { importLabel: importedSessionLabel(agent.imported_from.tool) }),
            ...(agent.updated_at === undefined
                ? {}
                : { updatedAt: agent.updated_at }),
            ...(agent.worker_pid === undefined
                ? {}
                : { workerPid: agent.worker_pid }),
            ...(agent.has_user_content === undefined
                ? {}
                : { hasUserContent: agent.has_user_content }),
        }));
}

export function isWorkspaceActive(session: WorkspaceSidebarSession): boolean {
    return session.live
        || session.status === "waiting"
        || session.status === "working"
        || session.workerPid !== undefined;
}

// Running sessions only. Parked history is behind `/resume`.
export function workspaceWorkingSet(
    sessions: readonly WorkspaceSidebarSession[],
): readonly WorkspaceSidebarSession[] {
    return sessions.filter(isWorkspaceActive);
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
        sessions: workspaceWorkingSet(state.sessions),
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
    const listed = workspaceWorkingSet(state.sessions).length;
    return listed === 0
        ? WORKSPACE_SIDEBAR_WORDMARK
        : `${WORKSPACE_SIDEBAR_WORDMARK} · ${listed}`;
}

// From the keymap, so a remap cannot leave the legend naming unbound keys.
export function workspaceSidebarHintTable(): readonly LinesViewFooterRow[] {
    return [
        { label: "Prev session", value: tuiKeyChordLabel("cycle_live_session_prev") },
        { label: "Next session", value: tuiKeyChordLabel("cycle_live_session_next") },
        { label: "Switch", value: tuiKeyChordLabel("toggle_workspace_sidebar") },
        {
            label: "Hide",
            value: `${tuiKeyChordLabel("open_model_prefix")} ${tuiKeyChordLabel("model_prefix_sidebar")}`,
        },
    ];
}

export function workspaceSidebarFooter(
    _width: number,
    table: readonly LinesViewFooterRow[],
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
    animationFrame = 0,
    summary: readonly LinesViewFooterRow[] = [],
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
            : { contentColumns: railContentColumns }),
    });
    const rowColumns = railColumns === undefined
        ? workspaceRowColumns(layout.width)
        : railColumns - RAIL_DIVIDER_COLUMNS;
    const lines: LinesViewState["lines"][number][] = [];
    for (const text of layout.rows.length === 0 ? WORKSPACE_EMPTY_LINES : []) {
        lines.push({ text, tone: "muted" as const });
    }
    let seenGroup = false;
    for (const row of layout.rows) {
        if (row.kind === "group") {
            if (seenGroup) {
                lines.push({ text: "", tone: "muted" as const });
            }
            seenGroup = true;
            lines.push({ text: row.text, tone: "heading" as const });
            continue;
        }
        // No rowId: a row without one draws as plain text and takes no pointer.
        lines.push({
            text: rightAlignedRow(row.text, row.detail, rowColumns),
            tone: row.id === state.currentId ? "muted" as const : "text" as const,
            ...(row.marker === WORKSPACE_COMPLETED_MARKER
                ? {
                    leading: {
                        text: WORKSPACE_COMPLETED_MARKER,
                        tone: "positive" as const,
                    },
                }
                : {}),
        });
    }
    const hints = workspaceSidebarHintTable();
    const footerTable = summary.length === 0
        ? hints
        : [...summary, { label: "", value: "" }, ...hints];
    return {
        title: workspaceSidebarHeader(state),
        titleLeading: {
            text: WORKSPACE_SIDEBAR_WORDMARK,
            tone: "accent",
        },
        ...(railColumns === undefined ? {} : { hint: "" }),
        lines,
        footer: workspaceSidebarFooter(columns, footerTable),
        footerTable,
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
