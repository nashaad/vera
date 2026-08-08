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

/** The line above the composer while a quote is waiting to be sent. */
export function renderTuiQuote(quote: TuiQuote | undefined): string {
    if (quote === undefined) {
        return "";
    }
    const count = [...quote.text].length;
    return `quoting ${quote.source} · ${count} character`
        + `${count === 1 ? "" : "s"} · esc to drop`;
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
