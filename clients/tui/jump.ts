import type { WorkRow } from "../../src/host/work-index.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

/**
 * The jump menu's presentation model, with no OpenTUI in it.
 *
 * The menu lists only the places there are to go from the current session:
 * the session the user jumped here from, sessions waiting on the user, and
 * the current session's parent and children. Facts come from the host (the
 * work index and the agent listing); the selection and the way back are
 * client state, so a GUI renders the same rows as a popover with its own
 * back affordance.
 */

export interface JumpOrigin {
    readonly sessionId: string;
    readonly sessionPath: string;
    readonly title: string;
}

export type JumpRowKind = "back" | "needs_you" | "parent" | "child";

export interface JumpRow {
    readonly kind: JumpRowKind;
    readonly sessionId: string;
    readonly sessionPath: string;
    /** What the row wants or is, not just which session it names. */
    readonly label: string;
    /** The session name, muted after the label when it adds anything. */
    readonly detail?: string;
}

export interface JumpMenuState {
    readonly rows: readonly JumpRow[];
    readonly selected: number;
}

const REASON_LABELS: Readonly<Record<string, string>> = {
    approval: "approval",
    question: "question",
    failure: "failed",
};

/**
 * Every row the menu can offer right now, in the order they are shown: back
 * first (so open-then-enter is the whole return trip), then what needs the
 * user, then the current session's own tree. The current session never lists
 * itself, and a needs-you row for the back target keeps the needs-you label,
 * because why you would go matters more than how you got here.
 */
export function buildJumpRows(input: {
    readonly currentId: string | undefined;
    readonly back: JumpOrigin | undefined;
    readonly needsYou: readonly WorkRow[];
    readonly agents: readonly RegisteredAgentSummary[];
}): JumpRow[] {
    const rows: JumpRow[] = [];
    const listed = new Set<string>();
    if (input.currentId !== undefined) listed.add(input.currentId);
    const needsYouIds = new Set(
        input.needsYou.map((row) => row.session_id),
    );
    if (
        input.back !== undefined
        && !listed.has(input.back.sessionId)
        && !needsYouIds.has(input.back.sessionId)
    ) {
        rows.push({
            kind: "back",
            sessionId: input.back.sessionId,
            sessionPath: input.back.sessionPath,
            label: input.back.title,
        });
        listed.add(input.back.sessionId);
    }
    for (const row of input.needsYou) {
        if (listed.has(row.session_id)) continue;
        listed.add(row.session_id);
        const reason = REASON_LABELS[row.reason ?? ""];
        rows.push({
            kind: "needs_you",
            sessionId: row.session_id,
            sessionPath: row.session_path,
            label: reason === undefined
                ? row.summary
                : `${row.summary} (${reason})`,
            detail: row.title,
        });
    }
    const current = input.agents.find((agent) => agent.id === input.currentId);
    const parent = current?.parent_id === undefined
        ? undefined
        : input.agents.find((agent) => agent.id === current.parent_id);
    if (parent !== undefined && !listed.has(parent.id)) {
        listed.add(parent.id);
        rows.push({
            kind: "parent",
            sessionId: parent.id,
            sessionPath: parent.session_path,
            label: agentLabel(parent),
        });
    }
    for (const agent of input.agents) {
        if (agent.parent_id !== input.currentId
            || input.currentId === undefined) continue;
        if (listed.has(agent.id)) continue;
        listed.add(agent.id);
        rows.push({
            kind: "child",
            sessionId: agent.id,
            sessionPath: agent.session_path,
            label: agentLabel(agent),
            detail: agent.live ? "working" : undefined,
        });
    }
    return rows;
}

function agentLabel(agent: RegisteredAgentSummary): string {
    return agent.title ?? agent.name ?? agent.id.slice(0, 8);
}

export function openJumpMenu(
    rows: readonly JumpRow[],
): JumpMenuState | undefined {
    return rows.length === 0 ? undefined : { rows, selected: 0 };
}

export type JumpMenuKeyResult =
    | { readonly kind: "state"; readonly state: JumpMenuState }
    | { readonly kind: "cancel" }
    | { readonly kind: "jump"; readonly row: JumpRow };

export function handleJumpMenuKey(
    state: JumpMenuState,
    keyName: string,
): JumpMenuKeyResult {
    if (keyName === "escape") return { kind: "cancel" };
    if (keyName === "return" || keyName === "enter") {
        const row = state.rows[state.selected];
        return row === undefined ? { kind: "cancel" } : { kind: "jump", row };
    }
    if (keyName === "up" || keyName === "down") {
        const delta = keyName === "up" ? -1 : 1;
        const count = state.rows.length;
        const selected = (state.selected + delta + count) % count;
        return { kind: "state", state: { ...state, selected } };
    }
    return { kind: "state", state };
}

const KIND_GLYPHS: Readonly<Record<JumpRowKind, string>> = {
    back: "←",
    needs_you: "!",
    parent: "↑",
    child: "↓",
};

const KIND_GROUPS: Readonly<Record<JumpRowKind, string>> = {
    back: "Back",
    needs_you: "Needs you",
    parent: "This session",
    child: "This session",
};

export interface JumpMenuLine {
    readonly text: string;
    readonly role: "header" | "row";
    /** Present on a row line: its index into the state's rows. */
    readonly rowIndex?: number;
    readonly selected?: boolean;
}

/** The menu as lines, group headers interleaved, ready to mount. */
export function jumpMenuLines(
    state: JumpMenuState,
    width: number,
): JumpMenuLine[] {
    const lines: JumpMenuLine[] = [];
    let group: string | undefined;
    state.rows.forEach((row, index) => {
        const heading = KIND_GROUPS[row.kind];
        if (heading !== group) {
            group = heading;
            lines.push({ text: heading, role: "header" });
        }
        const pointer = index === state.selected ? "> " : "  ";
        const glyph = KIND_GLYPHS[row.kind];
        const detail = row.detail === undefined ? "" : `  ${row.detail}`;
        lines.push({
            text: clip(`${pointer}${glyph} ${row.label}${detail}`, width),
            role: "row",
            rowIndex: index,
            selected: index === state.selected,
        });
    });
    return lines;
}

function clip(value: string, columns: number): string {
    if (columns <= 0) return "";
    return value.length <= columns
        ? value
        : `${value.slice(0, Math.max(1, columns - 1))}…`;
}
