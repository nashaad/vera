// A blank line follows the quote so the caret lands under it.
export function quoteReply(text: string): string {
    const lines = text.trim().split(/\r?\n/).map((line) => (line.trim() === "" ? ">" : `> ${line}`));
    return `${lines.join("\n")}\n\n`;
}
