import type { UiRequest } from "../engine/events.ts";
import type {
    RegisteredAgentKind,
    RegisteredAgentStatus,
} from "./agent-registry.ts";

/**
 * Every row belongs to exactly one section, and the order is fixed.
 *
 * `needs_you` is the only section a client may treat as a call to action, so
 * nothing lands there that the person cannot answer right now: a session
 * blocked on another session is working, not waiting on anyone.
 */
export type WorkSection =
    | "needs_you"
    | "working"
    | "ready_to_review"
    | "done_recently";

export type WorkReason =
    | "approval"
    | "question"
    | "failure"
    | "completion"
    | "review"
    | "schedule";

/**
 * One line of the work inbox, and the whole of what the wire carries.
 *
 * Deliberately a projection and never a record: nothing here is stored, every
 * field is recomputed from live host state, and a fact the host cannot assert
 * has no field to be written into. There is no task object behind this.
 */
export interface WorkRow {
    /** Stable across rebuilds so a client can keep its selection. */
    readonly id: string;
    readonly session_id: string;
    /**
     * Where the transcript lives, because enter opens the session and the
     * client resumes by path. Carried on the row rather than looked up after
     * the fact: the row and the path are one reading of the registry, and a
     * second reading could name a session the row no longer describes.
     */
    readonly session_path: string;
    readonly title: string;
    readonly section: WorkSection;
    readonly reason?: WorkReason;
    /** The human line: request summary, activity line, or completion note. */
    readonly summary: string;
    /** Absent rather than zero when a session has no running subagents. */
    readonly subagent_count?: number;
    /** Present on a review row: how many files the session changed. */
    readonly changed_files?: number;
    /** Directory path, carried so a client can disambiguate similar titles. */
    readonly workspace: string;
    /** ISO; clients render relative time. */
    readonly updated_at: string;
}

export interface WorkIndexSnapshot {
    readonly rows: readonly WorkRow[];
    readonly needs_you: number;
    readonly working: number;
}

export const EMPTY_WORK_INDEX: WorkIndexSnapshot = Object.freeze({
    rows: Object.freeze([]) as readonly WorkRow[],
    needs_you: 0,
    working: 0,
});

/** What the host knows about one session when the index is built. */
export interface WorkAgentFacts {
    readonly id: string;
    readonly session_path: string;
    readonly title: string;
    readonly workspace: string;
    readonly kind: RegisteredAgentKind;
    readonly status: RegisteredAgentStatus;
    readonly live: boolean;
    readonly updated_at: string;
    readonly parent_id?: string;
    /** The open request this session is blocked on, when it is blocked. */
    readonly pending_request?: UiRequest;
    /** The tool currently in flight, when one is. */
    readonly active_tool?: string;
    /** A finished background result nobody has opened yet. */
    readonly unread_result?: boolean;
    /**
     * How many files this session was the first to change.
     *
     * A count of what it touched, never a judgement about it: nothing here
     * knows whether an edit was later undone, whether it works, or whether it
     * is worth landing.
     */
    readonly changed_files?: number;
    /** Terminal failure text, when the session failed. */
    readonly failure?: string;
}

/** A schedule run the scheduler has already emitted. */
export interface WorkScheduleFacts {
    readonly schedule_id: string;
    readonly session_id: string;
    readonly session_path: string;
    readonly title: string;
    readonly workspace: string;
    readonly completed_at: string;
}

export interface WorkIndexOptions {
    /** Rows older than this drop out of `done_recently`. Search covers the past. */
    readonly recentWindowMs?: number;
    readonly now?: () => number;
    readonly maxRows?: number;
}

export const DEFAULT_WORK_RECENT_WINDOW_MS = 2 * 60 * 60 * 1_000;
export const DEFAULT_MAX_WORK_ROWS = 200;
const MAX_SUMMARY_LENGTH = 72;

const SECTION_ORDER: readonly WorkSection[] = [
    "needs_you",
    "working",
    "ready_to_review",
    "done_recently",
];

const WORK_REASONS: readonly WorkReason[] = [
    "approval",
    "question",
    "failure",
    "completion",
    "review",
    "schedule",
];

export function buildWorkIndex(
    agents: readonly WorkAgentFacts[],
    schedules: readonly WorkScheduleFacts[] = [],
    options: WorkIndexOptions = {},
): WorkIndexSnapshot {
    const now = (options.now ?? (() => Date.now()))();
    const window = options.recentWindowMs ?? DEFAULT_WORK_RECENT_WINDOW_MS;
    const maxRows = options.maxRows ?? DEFAULT_MAX_WORK_ROWS;
    const subagents = countRunningSubagents(agents);
    const keep = (row: WorkRow): boolean =>
        (row.section !== "done_recently" && row.section !== "ready_to_review")
        || isRecent(row.updated_at, now, window);

    const drafted = new Map<string, WorkRow>();
    for (const agent of agents) {
        const row = agentRow(agent, subagents.get(agent.id));
        if (row !== undefined && keep(row)) drafted.set(agent.id, row);
    }

    const rows: WorkRow[] = [];
    for (const agent of agents) {
        const row = drafted.get(agent.id);
        if (row === undefined) continue;
        // A running subagent is already on screen, as the count on its
        // parent's row. Listing it again would put one piece of work on the
        // inbox twice and make the working count disagree with itself.
        //
        // Only when the parent is actually on the list, though: a parent that
        // finished its turn while its children run has no row of its own, and
        // folding them into a row that is not there would hide running work
        // completely. A child blocked on its own approval always stands alone,
        // because the count on a parent row cannot be answered.
        if (agent.parent_id !== undefined
            && drafted.has(agent.parent_id)
            && agent.pending_request === undefined) {
            continue;
        }
        rows.push(row);
    }
    for (const schedule of schedules) {
        if (!isRecent(schedule.completed_at, now, window)) continue;
        rows.push({
            id: `schedule:${schedule.schedule_id}:${schedule.completed_at}`,
            session_id: schedule.session_id,
            session_path: schedule.session_path,
            title: schedule.title,
            section: "done_recently",
            reason: "schedule",
            summary: "Scheduled run completed",
            workspace: schedule.workspace,
            updated_at: schedule.completed_at,
        });
    }

    rows.sort(bySectionThenNewest);
    const bounded = rows.slice(0, maxRows);
    return {
        rows: bounded,
        needs_you: bounded.filter((row) => row.section === "needs_you").length,
        working: bounded.filter((row) => row.section === "working").length,
    };
}

/**
 * Whether a client already has this index.
 *
 * The registry reports that something changed, not what, and most changes it
 * reports leave every row identical. Comparing the rows is what keeps a client
 * from repainting the inbox on every keystroke in an unrelated session.
 */
export function sameWorkIndex(
    left: WorkIndexSnapshot,
    right: WorkIndexSnapshot,
): boolean {
    return left.needs_you === right.needs_you
        && left.working === right.working
        && left.rows.length === right.rows.length
        && left.rows.every((row, index) => sameWorkRow(row, right.rows[index]));
}

function sameWorkRow(left: WorkRow, right: WorkRow | undefined): boolean {
    return right !== undefined
        && left.id === right.id
        && left.session_id === right.session_id
        && left.session_path === right.session_path
        && left.title === right.title
        && left.section === right.section
        && left.reason === right.reason
        && left.summary === right.summary
        && left.subagent_count === right.subagent_count
        && left.changed_files === right.changed_files
        && left.workspace === right.workspace
        && left.updated_at === right.updated_at;
}

/**
 * The one shape a work index arrives in, whether it rode the attach response
 * or a later notification. Rejects rather than repairs: a row the client
 * cannot trust field by field is a row that would state work that is not there.
 */
export function parseWorkIndex(value: unknown): WorkIndexSnapshot | undefined {
    const snapshot = asRecord(value);
    if (
        snapshot === undefined
        || !Number.isSafeInteger(snapshot.needs_you)
        || (snapshot.needs_you as number) < 0
        || !Number.isSafeInteger(snapshot.working)
        || (snapshot.working as number) < 0
        || !Array.isArray(snapshot.rows)
        || snapshot.rows.length > DEFAULT_MAX_WORK_ROWS
    ) {
        return undefined;
    }
    const rows: WorkRow[] = [];
    for (const candidate of snapshot.rows) {
        const row = parseWorkRow(candidate);
        if (row === undefined) return undefined;
        rows.push(row);
    }
    return {
        rows,
        needs_you: snapshot.needs_you as number,
        working: snapshot.working as number,
    };
}

function parseWorkRow(value: unknown): WorkRow | undefined {
    const row = asRecord(value);
    if (
        row === undefined
        || !isText(row.id)
        || !isText(row.session_id)
        || !isText(row.session_path)
        || typeof row.title !== "string"
        || !isText(row.workspace)
        || typeof row.summary !== "string"
        || !(SECTION_ORDER as readonly unknown[]).includes(row.section)
        || (row.reason !== undefined
            && !(WORK_REASONS as readonly unknown[]).includes(row.reason))
        || (row.subagent_count !== undefined
            && (!Number.isSafeInteger(row.subagent_count)
                || (row.subagent_count as number) < 0))
        || (row.changed_files !== undefined
            && (!Number.isSafeInteger(row.changed_files)
                || (row.changed_files as number) < 0))
        || !isText(row.updated_at)
        || Number.isNaN(Date.parse(row.updated_at as string))
    ) {
        return undefined;
    }
    return {
        id: row.id as string,
        session_id: row.session_id as string,
        session_path: row.session_path as string,
        title: row.title,
        section: row.section as WorkSection,
        ...(row.reason === undefined
            ? {}
            : { reason: row.reason as WorkReason }),
        summary: row.summary,
        ...(row.subagent_count === undefined
            ? {}
            : { subagent_count: row.subagent_count as number }),
        ...(row.changed_files === undefined
            ? {}
            : { changed_files: row.changed_files as number }),
        workspace: row.workspace as string,
        updated_at: row.updated_at as string,
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function isText(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function agentRow(
    agent: WorkAgentFacts,
    subagentCount: number | undefined,
): WorkRow | undefined {
    const base = {
        id: agent.id,
        session_id: agent.id,
        session_path: agent.session_path,
        title: agent.title,
        workspace: agent.workspace,
        updated_at: agent.updated_at,
        ...(subagentCount === undefined ? {} : { subagent_count: subagentCount }),
    };

    if (agent.pending_request !== undefined) {
        return {
            ...base,
            section: "needs_you",
            reason: agent.pending_request.type === "tool_approval"
                ? "approval"
                : "question",
            summary: requestSummary(agent.pending_request),
        };
    }

    if (agent.failure !== undefined) {
        // A failure is actionable only where someone can act on it. An
        // interactive session the user is holding open can be retried from
        // where it stopped; a background failure is a result to read, and
        // putting it in `needs_you` would ask for an answer that has no
        // question behind it.
        const actionable = agent.kind === "interactive" && agent.live;
        return {
            ...base,
            section: actionable ? "needs_you" : "done_recently",
            reason: actionable ? "failure" : "completion",
            summary: truncate(agent.failure),
        };
    }

    if (agent.status === "working" || agent.status === "waiting") {
        return { ...base, section: "working", summary: activitySummary(agent) };
    }

    if (agent.unread_result === true) {
        return {
            ...base,
            section: "done_recently",
            reason: "completion",
            summary: "Finished, unread result",
        };
    }

    // Finished, and it changed something. The count is the whole claim: this
    // says a session touched files and stopped, not that the change is
    // correct, complete, or ready to land.
    if (agent.changed_files !== undefined && agent.changed_files > 0) {
        return {
            ...base,
            section: "ready_to_review",
            reason: "review",
            changed_files: agent.changed_files,
            summary: `${agent.changed_files} file${
                agent.changed_files === 1 ? "" : "s"
            } changed`,
        };
    }

    // Every other session the host is holding is simply on disk. Idle is not
    // work, and a list that showed it would describe last month's conversation
    // exactly as it describes the one being typed into.
    return undefined;
}

function activitySummary(agent: WorkAgentFacts): string {
    return agent.active_tool === undefined
        ? "Working"
        : `Running ${agent.active_tool}`;
}

function requestSummary(request: UiRequest): string {
    if (request.type === "user_question") {
        return truncate(oneLine(request.question));
    }
    const preview = toolCallPreview(request.toolCall.input);
    return truncate(
        preview === undefined
            ? request.toolCall.name
            : `${request.toolCall.name} ${preview}`,
    );
}

/**
 * The part of a tool call worth putting on one line.
 *
 * Named inputs only: the whole input is arbitrary tool-defined JSON, so
 * printing the first string it happens to hold would put a different field on
 * screen every time the tool changed shape.
 */
function toolCallPreview(
    input: Readonly<Record<string, unknown>>,
): string | undefined {
    for (const key of ["command", "file_path", "path", "pattern"]) {
        const value = input[key];
        if (typeof value === "string" && value.trim().length > 0) {
            return oneLine(value);
        }
    }
    return undefined;
}

function countRunningSubagents(
    agents: readonly WorkAgentFacts[],
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const agent of agents) {
        if (agent.parent_id === undefined) continue;
        if (agent.status !== "working" && agent.status !== "waiting") continue;
        counts.set(agent.parent_id, (counts.get(agent.parent_id) ?? 0) + 1);
    }
    return counts;
}

function bySectionThenNewest(left: WorkRow, right: WorkRow): number {
    const section = SECTION_ORDER.indexOf(left.section)
        - SECTION_ORDER.indexOf(right.section);
    if (section !== 0) return section;
    const newest = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (Number.isNaN(newest) || newest === 0) return left.id.localeCompare(right.id);
    return newest;
}

function isRecent(timestamp: string, now: number, window: number): boolean {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) || now - parsed <= window;
}

function oneLine(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
    const line = oneLine(value);
    return line.length <= MAX_SUMMARY_LENGTH
        ? line
        : `${line.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}
