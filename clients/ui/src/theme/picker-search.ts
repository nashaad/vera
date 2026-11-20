export interface ThemeSearchText {
    readonly label: string;
    readonly description: string;
}

export function filterThemes<T extends ThemeSearchText>(themes: readonly T[], query: string): T[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const first = terms[0];
    if (first === undefined) return [...themes];

    const prefixMatches: T[] = [];
    const labelMatches: T[] = [];
    const descriptionMatches: T[] = [];
    for (const theme of themes) {
        const label = theme.label.toLowerCase();
        if (terms.every((term) => label.includes(term))) {
            if (label.startsWith(first)) prefixMatches.push(theme);
            else labelMatches.push(theme);
        } else {
            const text = `${label} ${theme.description.toLowerCase()}`;
            if (terms.every((term) => text.includes(term))) descriptionMatches.push(theme);
        }
    }
    return [...prefixMatches, ...labelMatches, ...descriptionMatches];
}
