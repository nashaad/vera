import type { WorkIndexSnapshot, WorkRow } from "../../src/host/work-index.ts";

/**
 * Terminal notifications for work that started needing an answer while nobody
 * was looking at this terminal.
 *
 * Escape sequences only, and best effort: OSC 9 where the terminal honours it,
 * the bell where it does not, and nothing at all where neither lands. The
 * Work tab's counts are the guaranteed way to find out, so no behaviour here
 * may be load-bearing.
 */

/** Terminal focus reporting, so the client knows whether anyone is looking. */
export const FOCUS_REPORTING_ON = "\u001b[?1004h";
export const FOCUS_REPORTING_OFF = "\u001b[?1004l";

const FOCUS_IN = "\u001b[I";
const FOCUS_OUT = "\u001b[O";
const BELL = "\u0007";
const PASTE_START = "\u001b[200~";

export type TerminalFocusEvent = "focus_in" | "focus_out";

/**
 * The focus change in a chunk of raw terminal input, if it holds one.
 *
 * Read off the raw stream rather than the parsed keys, because the terminal
 * emulator sends these unasked and the key parser drops them: they are the
 * terminal answering a question this client asked, not something typed.
 *
 * A chunk can carry a focus event alongside real keystrokes, so this scans
 * rather than matching the whole chunk, and takes the last event in it. A
 * bracketed paste is exempt: the two sequences are ordinary text once someone
 * pastes a transcript, and reading those as focus changes would silence
 * notifications for the rest of the session.
 */
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
    /** Short, and it states the reason: this is read on a taskbar, not in a UI. */
    readonly text: string;
    readonly rowIds: readonly string[];
}

/**
 * What newly needs an answer, comparing two indexes.
 *
 * Compares row ids rather than counts: an approval answered and another
 * arriving in the same breath leaves the count unchanged, and that is exactly
 * the case a person must still be told about.
 */
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

/**
 * The notice for a batch of new rows, or nothing when the terminal is focused.
 *
 * Batched into one line: three approvals landing together are one interruption
 * worth having, and three are three too many.
 */
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

/**
 * The bytes to write for a notice.
 *
 * OSC 9 first because it carries the words. The bell is appended rather than
 * chosen, because a terminal that ignores OSC 9 gives no way to find out that
 * it did, and one that honours both simply rings once.
 */
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

/**
 * Control characters are stripped rather than escaped: the notice is written
 * straight into an escape sequence, so a title carrying its own terminator
 * would end the sequence early and print the rest as text.
 */
function sanitize(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
}
