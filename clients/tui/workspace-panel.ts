import type { VeraClientSession } from "../../src/sdk/extensions.ts";
import { relativeTime } from "../../src/relative-time.ts";

/**
 * The workspace list, described rather than drawn.
 *
 * `sidebar` in this client means the pair agent, so the left column is named
 * `workspace` throughout. This module takes session facts and returns rows;
 * it holds no state, keeps nothing between calls, and reads nothing beyond the
 * sessions it is handed.
 */

export type WorkspacePanelWidth = "wide" | "medium" | "narrow";

/**
 * Column budget, on the dashboard's breakpoints so the two surfaces change
 * shape at the same terminal widths.
 *
 * `narrow` does not mean a narrower column. It means there is no column: the
 * same rows are presented as a centred dialog.
 */
export function workspacePanelWidth(columns: number): WorkspacePanelWidth {
    if (columns >= 110) return "wide";
    return columns >= 74 ? "medium" : "narrow";
}

/** Content columns each width gives a row, before markers. */
const CONTENT_COLUMNS: Record<WorkspacePanelWidth, number> = {
    wide: 34,
    medium: 24,
    narrow: 46,
};

/** Columns the age reads in, right aligned, on the widths that show it. */
const AGE_COLUMNS = 8;

/** The selection marker, the status marker, and the space after each. */
const ROW_MARKER_COLUMNS = 4;

/**
 * Columns the longest row takes at this width, markers included.
 *
 * The widths that show an age take the age out of the title's budget rather
 * than adding to it, so every width is its content budget plus its markers,
 * and a surface that draws the listing in a column of its own can size that
 * column without laying the rows out first.
 */
export function workspaceRowColumns(width: WorkspacePanelWidth): number {
    return CONTENT_COLUMNS[width] + ROW_MARKER_COLUMNS;
}

const SELECTED_MARKER = "›";
const UNSELECTED_MARKER = " ";

/** The group background sessions collect under, kept last in the listing. */
export const BACKGROUND_GROUP = "background";

/**
 * The group pinned sessions collect under, kept first in the listing.
 *
 * A pin is one person's opinion about their own list, so it never reaches the
 * host. It is a sort key and a heading, not a mode: a pinned session is an
 * ordinary row that happens to be listed first.
 */
export const PINNED_GROUP = "pinned";

/**
 * Column one, as text. Colour may ride on top of it and may never replace it:
 * every state has to survive a monochrome render.
 */
export type WorkspaceRowMarker = "!" | "?" | "*" | "+" | "-" | ".";

export type WorkspaceSessionStatus = VeraClientSession["status"];

/**
 * A listed session, as this view needs it.
 *
 * `VeraClientSession` plus the one fact that separates a durable session from
 * an ephemeral one. The host knows it (`RegisteredAgentEntry.ephemeral`) and
 * neither `RegisteredAgentSummary` nor the extension projection carries it
 * yet, so the field is optional and an absent one means durable.
 */
export interface WorkspaceSession extends VeraClientSession {
    readonly ephemeral?: boolean;
}

/**
 * One character per status, all six distinct and none of them blank.
 *
 * Colour rides on top of this and may never replace it, so two statuses that
 * share a marker are indistinguishable to a reader whose terminal is not
 * showing colour.
 */
export function workspaceStatusMarker(
    status: WorkspaceSessionStatus,
): WorkspaceRowMarker {
    if (status === "failed") return "!";
    if (status === "waiting") return "?";
    if (status === "working") return "*";
    if (status === "completed") return "+";
    if (status === "closed") return "-";
    return ".";
}

export interface WorkspaceGroupRow {
    readonly kind: "group";
    /** The workspace path, or `background` for the background group. */
    readonly group: string;
    readonly sessions: number;
    readonly text: string;
}

export interface WorkspaceSessionRow {
    readonly kind: "session";
    /**
     * The session id. Selection is held by id rather than by index, so a
     * refresh that reorders the listing leaves the selection on the same
     * session.
     */
    readonly id: string;
    readonly group: string;
    readonly status: WorkspaceSessionStatus;
    readonly marker: WorkspaceRowMarker;
    readonly title: string;
    /** Empty on the widths that do not show an age. */
    readonly age: string;
    readonly selected: boolean;
    readonly text: string;
}

export type WorkspaceRow = WorkspaceGroupRow | WorkspaceSessionRow;

export interface WorkspacePanelLayout {
    readonly width: WorkspacePanelWidth;
    readonly rows: readonly WorkspaceRow[];
    /** Session ids in listing order. Group headers are never selectable. */
    readonly selectable: readonly string[];
    /** Absent when nothing is selectable. */
    readonly selectedId?: string;
}

export interface WorkspacePanelInput {
    readonly sessions: readonly WorkspaceSession[];
    readonly columns: number;
    readonly now: Date;
    /** Override the row's content budget for a user-resized rail. */
    readonly contentColumns?: number;
    /** Override the breakpoint's age policy for a user-resized rail. */
    readonly showAge?: boolean;
    /** Kept when it still names a listed session, replaced when it does not. */
    readonly selectedId?: string;
    /** Session ids the reader pinned. Client state; never sent anywhere. */
    readonly pinnedIds?: readonly string[];
    /**
     * The listing order the selection was last made against.
     *
     * When the selected session leaves the listing, selection lands on its
     * nearest surviving neighbour in this order rather than at the top.
     */
    readonly previousSelectable?: readonly string[];
    /**
     * The session whose transcript is on screen. Its title is drawn in
     * brackets, because the cursor can sit on another row without switching.
     */
    readonly currentId?: string;
}

/**
 * Whether a session is one a person can switch to.
 *
 * A durable session is an ordinary one and belongs in the list. An ephemeral
 * session keeps its transcript in a temporary directory that is removed when
 * the pane closes, so it is derived from the conversation already on screen
 * and has no life of its own to switch to.
 *
 * The test is what the session is, never a flag the caller chose to pass. A
 * session that does not say it is ephemeral is listed.
 */
export function isSwitchableSession(session: WorkspaceSession): boolean {
    return session.ephemeral !== true;
}

/**
 * Groups, orders, marks, and truncates the listing in one pass.
 *
 * Runs on every pushed status transition, so it does the work proportional to
 * the sessions it is handed and keeps nothing derived from a session that is
 * not selected.
 */
export function layoutWorkspacePanel(
    input: WorkspacePanelInput,
): WorkspacePanelLayout {
    const width = workspacePanelWidth(input.columns);
    const contentColumns = input.contentColumns ?? CONTENT_COLUMNS[width];
    const showAge = input.showAge ?? width !== "medium";
    const listed = input.sessions.filter(isSwitchableSession);
    const groups = groupSessions(listed, new Set(input.pinnedIds ?? []));
    const selectable = groups.flatMap((group) =>
        group.sessions.map((session) => session.id)
    );
    const selectedId = resolveSelection(
        selectable,
        input.selectedId,
        input.previousSelectable ?? [],
    );
    const rows: WorkspaceRow[] = [];
    for (const group of groups) {
        rows.push(groupRow(group, contentColumns));
        for (const session of group.sessions) {
            rows.push(sessionRow(session, group.group, {
                contentColumns,
                showAge,
                now: input.now,
                selected: session.id === selectedId,
                current: session.id === input.currentId,
            }));
        }
    }
    return {
        width,
        rows,
        selectable,
        ...(selectedId === undefined ? {} : { selectedId }),
    };
}

/**
 * The session `steps` rows away from the current one, counting only sessions.
 *
 * Group headers are skipped rather than landed on, so moving down off the last
 * session of a group lands on the first session of the next one. The ends do
 * not wrap: a list that wraps loses the reader's place when a refresh reorders
 * it.
 */
export function moveWorkspaceSelection(
    layout: WorkspacePanelLayout,
    steps: number,
): string | undefined {
    const selectable = layout.selectable;
    if (selectable.length === 0) return undefined;
    const current = layout.selectedId === undefined
        ? -1
        : selectable.indexOf(layout.selectedId);
    if (current < 0) return selectable[0];
    const next = Math.max(0, Math.min(selectable.length - 1, current + steps));
    return selectable[next];
}

interface SessionGroup {
    readonly group: string;
    readonly sessions: readonly WorkspaceSession[];
}

/**
 * Interactive sessions group by workspace, most recently touched group first.
 * Background agents collect in one group of their own at the bottom, whatever
 * workspace they were started in: they are work you left running rather than a
 * place you are working.
 */
function groupSessions(
    sessions: readonly WorkspaceSession[],
    pinned: ReadonlySet<string>,
): readonly SessionGroup[] {
    const byGroup = new Map<string, WorkspaceSession[]>();
    for (const session of sessions) {
        const group = pinned.has(session.id)
            ? PINNED_GROUP
            : session.kind === "background"
                ? BACKGROUND_GROUP
                : session.workspace;
        const existing = byGroup.get(group);
        if (existing === undefined) byGroup.set(group, [session]);
        else existing.push(session);
    }
    const groups: SessionGroup[] = [];
    for (const [group, members] of byGroup) {
        members.sort(byRecency);
        groups.push({ group, sessions: members });
    }
    groups.sort((left, right) => {
        if (left.group === PINNED_GROUP) return -1;
        if (right.group === PINNED_GROUP) return 1;
        if (left.group === BACKGROUND_GROUP) return 1;
        if (right.group === BACKGROUND_GROUP) return -1;
        // Compared on the timestamps alone rather than through `byRecency`,
        // whose id fallback would decide ties by uuid. Two workspaces touched
        // in the same minute read in name order instead, which is stable to
        // look at across redraws.
        const recency = timestamp(right.sessions[0]!.updatedAt)
            - timestamp(left.sessions[0]!.updatedAt);
        return recency === 0 ? left.group.localeCompare(right.group) : recency;
    });
    return groups;
}

/** Most recent first, falling back to the id so the order is total. */
function byRecency(left: WorkspaceSession, right: WorkspaceSession): number {
    const difference = timestamp(right.updatedAt) - timestamp(left.updatedAt);
    return difference === 0 ? left.id.localeCompare(right.id) : difference;
}

function timestamp(value: string | undefined): number {
    const parsed = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The session the selection lands on for this listing.
 *
 * A listing with nothing in it hands the selection back untouched: a roster
 * that arrives empty for one frame is a listing that has not loaded, not a
 * session that has gone away.
 */
function resolveSelection(
    selectable: readonly string[],
    selectedId: string | undefined,
    previousSelectable: readonly string[],
): string | undefined {
    if (selectable.length === 0) return selectedId;
    if (selectedId !== undefined && selectable.includes(selectedId)) {
        return selectedId;
    }
    return nearestSurvivor(selectable, selectedId, previousSelectable)
        ?? selectable[0];
}

/**
 * The listed session closest to where the lost one sat, searching outward from
 * its old position and preferring the row below it.
 */
function nearestSurvivor(
    selectable: readonly string[],
    selectedId: string | undefined,
    previousSelectable: readonly string[],
): string | undefined {
    if (selectedId === undefined) return undefined;
    const at = previousSelectable.indexOf(selectedId);
    if (at < 0) return undefined;
    const listed = new Set(selectable);
    for (let step = 1; step < previousSelectable.length; step += 1) {
        const below = previousSelectable[at + step];
        if (below !== undefined && listed.has(below)) return below;
        const above = at - step < 0 ? undefined : previousSelectable[at - step];
        if (above !== undefined && listed.has(above)) return above;
    }
    return undefined;
}

function groupRow(
    group: SessionGroup,
    contentColumns: number,
): WorkspaceGroupRow {
    const label = group.group === BACKGROUND_GROUP
            || group.group === PINNED_GROUP
        ? group.group
        : basename(group.group);
    const count = `${group.sessions.length}`;
    const room = contentColumns - count.length - 1;
    return {
        kind: "group",
        group: group.group,
        sessions: group.sessions.length,
        text: `${clip(label, Math.max(1, room))} ${count}`,
    };
}

interface RowContext {
    readonly contentColumns: number;
    readonly showAge: boolean;
    readonly now: Date;
    readonly selected: boolean;
    readonly current: boolean;
}

/** `[ ` and ` ]` around the title of the session on screen. */
const CURRENT_TITLE_WRAP = 4;

function sessionRow(
    session: WorkspaceSession,
    group: string,
    context: RowContext,
): WorkspaceSessionRow {
    const marker = workspaceStatusMarker(session.status);
    const title = session.title ?? session.id;
    const age = context.showAge
        ? relativeTime(session.updatedAt, context.now, "")
        : "";
    const room = context.contentColumns
        - (age.length === 0 ? 0 : AGE_COLUMNS + 1);
    const wrap = context.current ? CURRENT_TITLE_WRAP : 0;
    const shown = clip(title, Math.max(1, room - wrap));
    const display = context.current ? `[ ${shown} ]` : shown;
    const selectionMarker = context.selected
        ? SELECTED_MARKER
        : UNSELECTED_MARKER;
    const head = `${selectionMarker} ${marker} ${display}`;
    const text = age.length === 0
        ? head
        : `${pad(head, ROW_MARKER_COLUMNS + room)} ${age.padStart(AGE_COLUMNS)}`;
    return {
        kind: "session",
        id: session.id,
        group,
        status: session.status,
        marker,
        title: shown,
        age,
        selected: context.selected,
        text,
    };
}

function basename(workspace: string): string {
    const trimmed = workspace.replace(/\/+$/, "");
    const cut = trimmed.lastIndexOf("/");
    return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

function clip(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function pad(text: string, width: number): string {
    return text.length >= width ? text : text.padEnd(width);
}
