import type { VeraSearchProvider } from "../../sdk/extensions.ts";
import { boundedResult, builtInProviders, SearchError, type SearchFetch, type SearchResult } from "./providers.ts";
export type { SearchResult } from "./providers.ts";

export interface ProviderChoice { readonly provider: VeraSearchProvider; readonly enabled: boolean }
export interface SearchOutcome {
    readonly provider: VeraSearchProvider;
    readonly results: readonly SearchResult[];
    readonly notices: readonly string[];
}
interface SearchOptions {
    readonly timeoutMs?: number;
    readonly attemptTimeoutMs?: number;
}
export const NO_PROVIDER_HINT = "Connect Brave or Exa in /search-providers, "
    + "or install the DuckDuckGo example from examples/extensions/duckduckgo-search.";

export function searchInput(queryInput: unknown, limitInput: unknown): { query: string; limit: number } {
    if (typeof queryInput !== "string" || !queryInput.trim()) throw new Error("web_search requires a non-empty query.");
    const query = queryInput.trim();
    if (query.length > 600 || query.split(/\s+/).length > 75) throw new Error("web_search query must be at most 600 characters and 75 words.");
    const limit = limitInput === undefined ? 5 : limitInput;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("web_search max_results must be an integer from 1 to 10.");
    return { query, limit };
}
export async function searchWeb(
    queryInput: unknown, limitInput: unknown, choices: readonly ProviderChoice[],
    keyFor: (provider: VeraSearchProvider) => string | undefined, signal: AbortSignal,
    options: SearchOptions = {},
): Promise<SearchOutcome> {
    const { query, limit } = searchInput(queryInput, limitInput);
    if (signal.aborted) throw new Error("Web search cancelled.");
    const notices: string[] = [];
    let attempted = false;
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    for (const { provider } of choices.filter((entry) => entry.enabled)) {
        if (signal.aborted) throw new Error("Web search cancelled.");
        const key = keyFor(provider)?.trim() || undefined;
        if (provider.requiresKey && !key) {
            notices.push(`${provider.label}: API key unavailable (${provider.keyEnv ? `${provider.keyEnv} or ` : ""}/search-providers).`);
            continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) { notices.push("Web search timed out."); break; }
        attempted = true;
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal]);
        const timer = setTimeout(() => controller.abort(), Math.min(remaining, options.attemptTimeoutMs ?? 5_000));
        try {
            const raw = await provider.search({ query, count: limit, key, signal: combined });
            if (!Array.isArray(raw)) throw new SearchError(`${provider.label} search returned invalid results.`);
            const results = raw.flatMap((row): SearchResult[] => {
                if (typeof row?.title !== "string" || typeof row.url !== "string" || typeof row.snippet !== "string") {
                    throw new SearchError(`${provider.label} search returned an invalid result.`);
                }
                const result = boundedResult(row.title, row.url, row.snippet);
                return result ? [result] : [];
            }).slice(0, limit);
            return { provider, results, notices };
        } catch (error) {
            if (signal.aborted) throw new Error("Web search cancelled.");
            notices.push(controller.signal.aborted ? `${provider.label} search timed out.`
                : error instanceof Error ? error.message : `${provider.label} search failed.`);
        } finally { clearTimeout(timer); }
    }
    if (!attempted) {
        throw new Error([`No search provider is ready. ${NO_PROVIDER_HINT}`, ...notices].join(" "));
    }
    throw new Error(`Web search failed. ${notices.join(" ")}`);
}

export async function searchBrave(
    query: unknown, limit: unknown, key: string | undefined, signal: AbortSignal,
    options: SearchOptions & { readonly fetcher?: SearchFetch } = {},
): Promise<readonly SearchResult[]> {
    searchInput(query, limit);
    if (!key?.trim()) throw new Error("Web search requires BRAVE_API_KEY or a saved Brave key in /search-providers.");
    const brave = builtInProviders(options.fetcher).find((provider) => provider.id === "brave")!;
    return (await searchWeb(query, limit, [{ provider: brave, enabled: true }], () => key, signal,
        { ...options, attemptTimeoutMs: options.timeoutMs ?? 15_000 })).results;
}
export function formatSearchResults(results: readonly SearchResult[], label = "Brave", notices: readonly string[] = []): string {
    return [
        `Provider: ${label}`,
        ...notices.map((notice) => `Fallback: ${notice}`),
        ...(results.length ? results.map((result, index) => `\n${index + 1}. ${result.title}\n   URL: ${result.url}\n   ${result.snippet}`) : ["No results found."]),
    ].join("\n");
}
