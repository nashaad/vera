// Every word of the query must appear in the text, in any order. A blank query matches.
export function matchesSettingsQuery(text: string, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return true;
    const haystack = text.toLowerCase();
    return words.every((word) => haystack.includes(word));
}
