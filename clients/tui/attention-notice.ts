import type { WorkIndexSnapshot, WorkRow } from "../../src/host/work-index.ts";

export const FOCUS_REPORTING_ON = "\u001b[?1004h";
export const FOCUS_REPORTING_OFF = "\u001b[?1004l";

const FOCUS_IN = "\u001b[I";
const FOCUS_OUT = "\u001b[O";
const BELL = "\u0007";
const PASTE_START = "\u001b[200~";

export type TerminalFocusEvent = "focus_in" | "focus_out";

export function parseTerminalFocusEvent(
    chunk: string,
): TerminalFocusEvent | undefined {
    if (chunk.includes(PASTE_START)) return undefined;
    const lastIn = chunk.lastIndexOf(FOCUS_IN);
    const lastOut = chunk.lastIndexOf(FOCUS_OUT);
    if (lastIn === -1 && lastOut === -1) return undefined;
    return lastIn > lastOut ? "focus_in" : "focus_out";
}

export interface AttentionNotice {
    readonly text: string;
    readonly rowIds: readonly string[];
}

export function newAttentionRows(
    previous: WorkIndexSnapshot | undefined,
    next: WorkIndexSnapshot,
): readonly WorkRow[] {
    const known = new Set(
        (previous?.rows ?? [])
            .filter(isAttentionRow)
            .map((row) => row.id),
    );
    return next.rows.filter((row) => isAttentionRow(row) && !known.has(row.id));
}

export function attentionNotice(
    rows: readonly WorkRow[],
    focused: boolean,
): AttentionNotice | undefined {
    if (focused || rows.length === 0) return undefined;
    const rowIds = rows.map((row) => row.id);
    const first = rows[0];
    if (first === undefined) return undefined;
    if (rows.length > 1) {
        return { text: `${rows.length} sessions need you`, rowIds };
    }
    return { text: `${first.title} ${needs(first)}`, rowIds };
}

export function attentionNoticeSequence(notice: AttentionNotice): string {
    return `\u001b]9;${sanitize(notice.text)}\u001b\\${BELL}`;
}

function needs(row: WorkRow): string {
    switch (row.reason) {
        case "approval":
            return "needs approval";
        case "question":
            return "has a question";
        case "failure":
            return "failed";
        default:
            return "finished";
    }
}

function isAttentionRow(row: WorkRow): boolean {
    return row.section === "needs_you"
        || (row.section === "done_recently" && row.reason === "completion");
}

function sanitize(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
}
