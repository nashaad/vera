import type {
    ClientExtensionComposeSuggesterDescriptor,
} from "../../src/extensions/client-registry.ts";

/**
 * Resolve the first compose offer that is eligible for the current agent.
 * Matching belongs to extensions; this helper only applies client state.
 */
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
        && !dismissed.has(`${suggester.source}:${suggester.agent}`)
        && suggester.matches(text)
    );
}
