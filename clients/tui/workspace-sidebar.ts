import type { LinesViewState } from "./lines-view.ts";
import {
    layoutWorkspacePanel,
    moveWorkspaceSelection,
    type WorkspacePanelLayout,
    type WorkspaceSession,
    type WorkspaceSessionStatus,
} from "./workspace-panel.ts";
import { tuiBindingId } from "./keymap.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";

/**
 * The workspace side bar's presentation model, with no OpenTUI in it.
 *
 * `workspace-panel.ts` decides rows, order and markers. This module holds the
 * little that a drawn side bar adds: which row the cursor is on, which rows the
 * digits address, what a pin does, and the lines the shared card mounts.
 */

/** Rows the digit keys can address, counting from the top of the listing. */
export const WORKSPACE_JUMP_ROWS = 9;

const NARROW_WIDTH = 64;

/**
 * A listed session plus where its transcript lives.
 *
 * Switching resumes by path, and the path and the row are one reading of the
 * registry: looking it up again afterwards could name a session the row no
 * longer describes.
 */
export interface WorkspaceSidebarSession extends WorkspaceSession {
    readonly sessionPath: string;
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
    | {
        readonly kind: "open_session";
        readonly session_id: string;
        readonly session_path: string;
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
    return agents.map((agent) => ({
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
    }));
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
    if (row.section === "done_recently") return "completed";
    return "idle";
}

/** A fresh index from the host, folded onto the rows already listed. */
export function applyWorkspaceWorkIndex(
    state: WorkspaceSidebarState,
    index: WorkIndexSnapshot,
): WorkspaceSidebarState {
    return {
        ...state,
        sessions: state.sessions.map((session) => {
            const status = workIndexStatus(index, session.id);
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
}

export function workspaceSidebarLayout(
    state: WorkspaceSidebarState,
    input: WorkspaceSidebarLayoutInput,
): WorkspacePanelLayout {
    return layoutWorkspacePanel({
        sessions: state.sessions,
        columns: input.columns,
        now: input.now,
        pinnedIds: state.pinnedIds,
        ...(state.selectedId === undefined
            ? {}
            : { selectedId: state.selectedId }),
    });
}

/** The session a digit addresses, or nothing past the end of the listing. */
export function workspaceJumpTarget(
    layout: WorkspacePanelLayout,
    position: number,
): string | undefined {
    if (position < 1 || position > WORKSPACE_JUMP_ROWS) return undefined;
    return layout.selectable[position - 1];
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
 * Arrows move, enter opens, escape closes, digits address the top nine rows.
 *
 * Every chord this does not claim is passed back unhandled, which is what lets
 * ctrl+e close the pane it opened and ctrl+c reach the client from inside it.
 */
export function handleWorkspaceSidebarKey(
    state: WorkspaceSidebarState,
    key: WorkspaceSidebarKey,
    now: Date,
    columns: number,
): WorkspaceSidebarTransition {
    if (key.ctrl || key.meta) return { state, handled: false };
    const layout = workspaceSidebarLayout(state, { columns, now });
    if (key.name === "escape") {
        return { action: { kind: "close" }, handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        const selectedId = moveWorkspaceSelection(
            layout,
            key.name === "up" ? -1 : 1,
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
    if (tuiBindingId("workspace", key) === "toggle_workspace_pin") {
        const selectedId = layout.selectedId;
        if (selectedId === undefined) return { state, handled: true };
        const pinnedIds = toggleWorkspacePin(state.pinnedIds, selectedId);
        return {
            state: { ...state, pinnedIds },
            action: { kind: "pin", pinnedIds },
            handled: true,
        };
    }
    const binding = tuiBindingId("workspace", key);
    if (binding !== undefined && binding.startsWith("workspace_jump_")) {
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

/** What activating a row means. Selecting a row switches the viewed session. */
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
    };
}

export function workspaceSidebarHeader(state: WorkspaceSidebarState): string {
    const listed = state.sessions.length;
    return listed === 0 ? "Workspace" : `Workspace · ${listed}`;
}

/**
 * The footer hint, in the pickers' shape.
 *
 * The digits live here rather than in the help card: nine near-identical rows
 * would push the Transcript scope below the fold, and the only place they are
 * useful is the pane that is already on screen.
 */
export function workspaceSidebarFooter(width: number): string {
    return width < NARROW_WIDTH
        ? "↑↓ enter 1-9 p esc"
        : "↑↓ browse · enter open · 1-9 jump · p pin · esc close";
}

/** The side bar as the shared card draws it. */
export function workspaceSidebarViewState(
    state: WorkspaceSidebarState,
    width: number,
    now: Date = new Date(),
): LinesViewState {
    const layout = workspaceSidebarLayout(state, { columns: width, now });
    let position = 0;
    const lines: LinesViewState["lines"][number][] = layout.rows.map((row) => {
        if (row.kind === "group") {
            return { text: row.text, tone: "accent" as const };
        }
        position += 1;
        // The digit is drawn on the row it addresses. Positional and churning
        // as the list reorders, which is why it is a shortcut and not the way
        // a row is picked.
        const digit = position <= WORKSPACE_JUMP_ROWS ? `${position}` : " ";
        // Text, never colour alone: the row on screen says so in words, so a
        // monochrome render still tells you where you are.
        const here = row.id === state.currentId ? " (here)" : "";
        return {
            text: `${digit} ${row.text}${here}`,
            tone: "text" as const,
            rowId: row.id,
            ...(row.selected ? { selected: true } : {}),
        };
    });
    const cursorLine = lines.findIndex((line) => line.selected === true);
    return {
        title: workspaceSidebarHeader(state),
        ...(cursorLine === -1 ? {} : { cursorLine }),
        lines: lines.length === 0
            ? [{ text: "No other sessions.", tone: "muted" as const }]
            : lines,
        footer: workspaceSidebarFooter(width),
    };
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
