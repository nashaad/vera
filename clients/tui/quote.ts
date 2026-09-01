export interface TuiQuote {
    readonly source: string;
    readonly text: string;
}

const BLINK_PERIOD_MS = 600;

export function tuiQuoteMarker(nowMs: number): string {
    return Math.floor(nowMs / BLINK_PERIOD_MS) % 2 === 0 ? "*" : " ";
}

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

export function quotedBlock(quote: TuiQuote): string {
    const quoted = quote.text
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .split("\n")
        .map((line) => (line.length === 0 ? ">" : `> ${line}`))
        .join("\n");
    return `${quote.source} said:\n${quoted}`;
}

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
