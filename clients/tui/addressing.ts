/**
 * The line that says a message is not going where it usually goes.
 *
 * An extension can hold the composer for someone other than the agent. That is
 * a mode, and a mode has to be visible for as long as it lasts: said once in
 * the transcript, it scrolls away, and the next message goes somewhere the
 * sender no longer remembers choosing.
 */

/**
 * The pinned line above the composer while an address is held, in two parts:
 * where messages are going, and how to stop.
 *
 * Two parts because they are two kinds of sentence, drawn in two colours. The
 * first is a fact about the state. The second is the way out, which is the
 * half that has to be legible.
 */
export function renderTuiHeldAddress(
    name: string | undefined,
): { facts: string; keys: string } {
    if (name === undefined || name.trim().length === 0) {
        return { facts: "", keys: "" };
    }
    return {
        facts: `every message goes to ${name.trim()}`,
        keys: "@vera goes back to the agent",
    };
}
