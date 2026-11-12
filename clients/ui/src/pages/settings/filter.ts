export interface SearchableSection {
    readonly name: string;
    readonly terms: string;
}

// Every word of the query must appear in the name or the terms, in any order.
export function filterSettings<T extends SearchableSection>(sections: readonly T[], query: string): readonly T[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return sections;
    return sections.filter((section) => {
        const haystack = `${section.name} ${section.terms}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
    });
}
