import type { VeraClientSession } from "../../src/sdk/extensions.ts";
import { relativeTime } from "../../src/relative-time.ts";
import { tuiBrailleSpinner } from "./activity-pulse.ts";

export type WorkspacePanelWidth = "wide" | "medium" | "narrow";

export function workspacePanelWidth(columns: number): WorkspacePanelWidth {
    if (columns >= 110) return "wide";
    return columns >= 74 ? "medium" : "narrow";
}

const CONTENT_COLUMNS: Record<WorkspacePanelWidth, number> = {
    wide: 34,
    medium: 24,
    narrow: 46,
};

const ROW_PREFIX_COLUMNS = 2;

export function workspaceRowColumns(width: WorkspacePanelWidth): number {
    return CONTENT_COLUMNS[width] + ROW_PREFIX_COLUMNS;
}

export const PINNED_GROUP = "PINNED";
export const WORKSPACE_PINS_ENABLED = false;
export const NEEDS_YOU_GROUP = "NEEDS YOU";
export const WORKING_GROUP = "WORKING";
export const IDLE_GROUP = "IDLE";
export const RECENT_GROUP = "RECENT";

export const UNTITLED_SESSION = "untitled";

export type WorkspaceRowMarker = string;

export type WorkspaceSessionStatus = VeraClientSession["status"];

export interface WorkspaceSession extends VeraClientSession {
    readonly ephemeral?: boolean;
}

export const WORKSPACE_WAITING_MARKER = "!";
export const WORKSPACE_COMPLETED_MARKER = "✓";
export const WORKSPACE_IDLE_MARKER = ".";
export const WORKSPACE_RECENT_MARKER = "·";
export const WORKSPACE_COMPLETED_WINDOW_MS = 10 * 60 * 1_000;

export function workspaceStatusMarker(
    status: WorkspaceSessionStatus,
    frame = 0,
    live = false,
    updatedAt?: string,
    now?: Date,
): WorkspaceRowMarker {
    if (status === "waiting" || (status === "failed" && live)) {
        return WORKSPACE_WAITING_MARKER;
    }
    if (status === "working") return tuiBrailleSpinner(frame);
    if (
        live
        && (status === "completed" || status === "idle")
        && recentlyFinished(updatedAt, now)
    ) {
        return WORKSPACE_COMPLETED_MARKER;
    }
    return live ? WORKSPACE_IDLE_MARKER : WORKSPACE_RECENT_MARKER;
}

function recentlyFinished(
    updatedAt: string | undefined,
    now: Date | undefined,
): boolean {
    if (updatedAt === undefined || now === undefined) return false;
    const parsed = Date.parse(updatedAt);
    if (!Number.isFinite(parsed)) return false;
    const elapsed = now.getTime() - parsed;
    return elapsed >= 0 && elapsed <= WORKSPACE_COMPLETED_WINDOW_MS;
}

export interface WorkspaceGroupRow {
    readonly kind: "group";
    readonly group: string;
    readonly sessions: number;
    readonly text: string;
}

export interface WorkspaceSessionRow {
    readonly kind: "session";
    readonly id: string;
    readonly group: string;
    readonly active: boolean;
    readonly status: WorkspaceSessionStatus;
    readonly marker: WorkspaceRowMarker;
    readonly title: string;
    readonly age: string;
    readonly selected: boolean;
    readonly text: string;
    readonly detail: string;
}

export type WorkspaceRow = WorkspaceGroupRow | WorkspaceSessionRow;

export interface WorkspacePanelLayout {
    readonly width: WorkspacePanelWidth;
    readonly rows: readonly WorkspaceRow[];
    readonly selectable: readonly string[];
    readonly selectedId?: string;
}

export interface WorkspacePanelInput {
    readonly sessions: readonly WorkspaceSession[];
    readonly columns: number;
    readonly now: Date;
    readonly contentColumns?: number;
    readonly showAge?: boolean;
    readonly selectedId?: string;
    readonly pinnedIds?: readonly string[];
    readonly previousSelectable?: readonly string[];
    readonly currentId?: string;
    readonly animationFrame?: number;
    readonly isActive?: (session: WorkspaceSession) => boolean;
}

export function isSwitchableSession(session: WorkspaceSession): boolean {
    return session.ephemeral !== true;
}

function namedWorker(session: WorkspaceSession): boolean {
    return "workerPid" in session
        && typeof (session as { workerPid?: number }).workerPid === "number";
}

export function layoutWorkspacePanel(
    input: WorkspacePanelInput,
): WorkspacePanelLayout {
    const width = workspacePanelWidth(input.columns);
    const contentColumns = input.contentColumns ?? CONTENT_COLUMNS[width];
    const showAge = input.showAge ?? width !== "medium";
    const listed = input.sessions.filter(isSwitchableSession);
    const isActive = input.isActive ?? defaultActive;
    const showWorkspace = new Set(
        listed.map((session) => workspaceGroupPath(session.workspace)),
    ).size > 1;
    const groups = groupSessions(
        listed,
        new Set(input.pinnedIds ?? []),
        isActive,
    );
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
            rows.push(sessionRow(session, group.group, isActive(session), {
                contentColumns,
                showAge,
                now: input.now,
                selected: session.id === selectedId,
                animationFrame: input.animationFrame ?? 0,
                showWorkspace,
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

function defaultActive(session: WorkspaceSession): boolean {
    return session.live
        || session.status === "waiting"
        || session.status === "working"
        || namedWorker(session);
}

function actionableFailure(
    session: WorkspaceSession,
    isActive: (session: WorkspaceSession) => boolean,
): boolean {
    return session.status === "failed"
        && session.kind === "interactive"
        && isActive(session);
}

function groupSessions(
    sessions: readonly WorkspaceSession[],
    pinned: ReadonlySet<string>,
    isActive: (session: WorkspaceSession) => boolean,
): readonly SessionGroup[] {
    const byGroup = new Map<string, WorkspaceSession[]>([
        [NEEDS_YOU_GROUP, []],
        [WORKING_GROUP, []],
        [IDLE_GROUP, []],
        [PINNED_GROUP, []],
        [RECENT_GROUP, []],
    ]);
    for (const session of sessions) {
        const group = WORKSPACE_PINS_ENABLED && pinned.has(session.id)
            ? PINNED_GROUP
            : session.status === "failed"
            ? actionableFailure(session, isActive)
                ? NEEDS_YOU_GROUP
                : RECENT_GROUP
            : session.status === "waiting"
            ? NEEDS_YOU_GROUP
            : session.status === "working"
            ? WORKING_GROUP
            : isActive(session)
            ? IDLE_GROUP
            : RECENT_GROUP;
        byGroup.get(group)!.push(session);
    }
    const groups: SessionGroup[] = [];
    for (const [group, members] of byGroup) {
        if (members.length === 0) continue;
        members.sort(byRecency);
        groups.push({ group, sessions: members });
    }
    return groups;
}

function byRecency(left: WorkspaceSession, right: WorkspaceSession): number {
    const difference = timestamp(right.updatedAt) - timestamp(left.updatedAt);
    return difference === 0 ? left.id.localeCompare(right.id) : difference;
}

function timestamp(value: string | undefined): number {
    const parsed = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

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
    return {
        kind: "group",
        group: group.group,
        sessions: group.sessions.length,
        text: clip(group.group, Math.max(1, contentColumns)),
    };
}

interface RowContext {
    readonly contentColumns: number;
    readonly showAge: boolean;
    readonly now: Date;
    readonly selected: boolean;
    readonly animationFrame: number;
    readonly showWorkspace: boolean;
}

function sessionRow(
    session: WorkspaceSession,
    group: string,
    active: boolean,
    context: RowContext,
): WorkspaceSessionRow {
    const marker = workspaceStatusMarker(
        session.status,
        context.animationFrame,
        session.status === "failed" ? group === NEEDS_YOU_GROUP : active,
        session.updatedAt,
        context.now,
    );
    const title = session.title ?? UNTITLED_SESSION;
    const age = context.showAge && group === RECENT_GROUP
        ? relativeTime(session.updatedAt, context.now, "")
        : "";
    const shown = clip(title, Math.max(1, context.contentColumns));
    const text = `${marker} ${shown}`;
    const detail = group === RECENT_GROUP
        ? age
        : context.showWorkspace
        ? basename(workspaceGroupPath(session.workspace))
        : "";
    return {
        kind: "session",
        id: session.id,
        group,
        status: session.status,
        marker,
        active,
        title: shown,
        age,
        selected: context.selected,
        text,
        detail,
    };
}

export function workspaceGroupPath(workspace: string): string {
    const marker = "/.worktrees/";
    const at = workspace.indexOf(marker);
    return at > 0 ? workspace.slice(0, at) : workspace;
}

function basename(workspace: string): string {
    const trimmed = workspace.replace(/\/+$/, "");
    const cut = trimmed.lastIndexOf("/");
    return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

function clip(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
