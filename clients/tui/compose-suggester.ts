import type {
    ClientExtensionComposeSuggesterDescriptor,
} from "../../src/extensions/client-registry.ts";

export function findActiveComposeSuggester(
    suggesters: readonly ClientExtensionComposeSuggesterDescriptor[],
    text: string,
    currentAgent: string,
    dismissed: ReadonlySet<string>,
): ClientExtensionComposeSuggesterDescriptor | undefined {
    if (text.trim().length === 0 || text.startsWith("/")) return undefined;
    return suggesters.find((suggester) =>
        currentAgent !== suggester.agent
        && (
            suggester.fromAgents === undefined
            || suggester.fromAgents.includes(currentAgent)
        )
        && !dismissed.has(composeSuggesterDismissalKey(suggester))
        && suggester.matches(text)
    );
}

export function composeSuggesterDismissalKey(
    suggester: Pick<ClientExtensionComposeSuggesterDescriptor, "source" | "id">,
): string {
    return `${suggester.source}:${suggester.id}`;
}
