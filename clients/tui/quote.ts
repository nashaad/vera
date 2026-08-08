/**
 * Text carried from one pane into the next message.
 *
 * A seat reads the main thread and nothing it says comes back on its own, so
 * this is the only way an answer crosses: the user selects it, and it rides
 * along with whatever they type next. What crosses names where it came from,
 * because a quotation with no speaker reads as the sender's own words.
 */
export interface TuiQuote {
    /** The pane the text was taken from, such as an alias or "vera". */
    readonly source: string;
    readonly text: string;
}

/** How long the mark above the composer spends lit, then dark. */
const BLINK_PERIOD_MS = 600;

/**
 * The mark that draws the eye to a waiting quote.
 *
 * A space rather than nothing while it is dark, so the line does not shift by
 * a column twice a second.
 */
export function tuiQuoteMarker(nowMs: number): string {
    return Math.floor(nowMs / BLINK_PERIOD_MS) % 2 === 0 ? "*" : " ";
}

/**
 * The line above the composer while a quote is waiting to be sent, in two
 * parts: what is held, and what to do with it.
 *
 * They are drawn in different colours because they are different kinds of
 * sentence. The first is a fact about the state, read once. The second is a
 * list of keys, and a key nobody sees is a key nobody presses: the escape that
 * clears the quote is the one that has to be legible, because it is the only
 * way out.
 */
export function renderTuiQuote(
    quote: TuiQuote | undefined,
): { facts: string; keys: string } {
    if (quote === undefined) {
        return { facts: "", keys: "" };
    }
    const count = [...quote.text].length;
    return {
        facts: `quoting ${quote.source} · ${count} character`
            + `${count === 1 ? "" : "s"} · copied`,
        keys: "⏎ sends it · @name aims it · esc clears it",
    };
}

/** The quote as the recipient reads it, appended to the typed message. */
export function quotedBlock(quote: TuiQuote): string {
    const quoted = quote.text
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .split("\n")
        .map((line) => (line.length === 0 ? ">" : `> ${line}`))
        .join("\n");
    return `${quote.source} said:\n${quoted}`;
}

/**
 * The message as it goes out.
 *
 * The quote follows the typed line rather than leading it, so an address like
 * `@frosty` stays at the front where the extension that reads it looks.
 */
export function withQuote(
    typed: string,
    quote: TuiQuote | undefined,
): string {
    if (quote === undefined || quote.text.trim().length === 0) {
        return typed;
    }
    const block = quotedBlock(quote);
    return typed.trim().length === 0 ? block : `${typed}\n\n${block}`;
}
