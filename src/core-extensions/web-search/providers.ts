import type { VeraSearchProvider, VeraSearchResult } from "../../sdk/extensions.ts";

export type SearchResult = VeraSearchResult;
export type SearchFetch = (input: URL, init: RequestInit) => Promise<Response>;
export class SearchError extends Error {}

export const BUILT_IN_PROVIDERS = ["brave", "exa"] as const;

export function builtInProviders(fetcher: SearchFetch = (input, init) => fetch(input, init)): readonly VeraSearchProvider[] {
    return [
        { id: "brave", label: "Brave", requiresKey: true, keyEnv: "BRAVE_API_KEY",
            search: ({ query, count, key, signal }) => searchBuiltIn("brave", query, count, key, signal, fetcher) },
        { id: "exa", label: "Exa", requiresKey: true, keyEnv: "EXA_API_KEY",
            search: ({ query, count, key, signal }) => searchBuiltIn("exa", query, count, key, signal, fetcher) },
    ];
}

type BuiltIn = typeof BUILT_IN_PROVIDERS[number];
const NAMES: Record<BuiltIn, string> = { brave: "Brave", exa: "Exa" };
const ENV: Record<BuiltIn, string> = { brave: "BRAVE_API_KEY", exa: "EXA_API_KEY" };

async function searchBuiltIn(
    provider: BuiltIn, query: string, count: number, key: string | undefined,
    signal: AbortSignal, fetcher: SearchFetch,
): Promise<readonly SearchResult[]> {
    const url = new URL(provider === "brave" ? "https://api.search.brave.com/res/v1/web/search" : "https://api.exa.ai/search");
    let init: RequestInit;
    if (provider === "brave") {
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(count));
        url.searchParams.set("text_decorations", "false");
        init = { headers: { Accept: "application/json", "X-Subscription-Token": key ?? "" } };
    } else {
        init = {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": key ?? "" },
            body: JSON.stringify({ query, numResults: count, type: "auto", contents: { highlights: { maxCharacters: 2_000 } } }),
        };
    }
    try {
        const response = await fetcher(url, { ...init, signal, redirect: "error" });
        if (!response.ok) {
            await response.body?.cancel();
            const advice = response.status === 401 || response.status === 403
                ? ` Check ${ENV[provider]} and its search subscription.`
                : response.status === 429 || response.status === 402
                    ? " Rate or quota limit reached. Try later or check your subscription."
                    : " Try again later.";
            throw new SearchError(`${NAMES[provider]} search failed with HTTP ${response.status}.${advice}`);
        }
        const text = await readBody(response, NAMES[provider]);
        let body: unknown;
        try { body = JSON.parse(text); }
        catch { throw new SearchError(`${NAMES[provider]} search returned invalid JSON.`); }
        const record = object(body);
        if (provider === "brave" && record?.type !== "search") {
            throw new SearchError("Brave search returned an invalid response.");
        }
        const raw = provider === "brave"
            ? record?.web == null ? [] : object(record.web)?.results
            : record?.results;
        if (!Array.isArray(raw)) throw new SearchError(`${NAMES[provider]} search returned invalid results.`);
        return raw.map((item): SearchResult => {
            const row = object(item);
            if (typeof row?.title !== "string" || !row.title.trim() || typeof row.url !== "string") {
                throw new SearchError(`${NAMES[provider]} search returned an invalid result.`);
            }
            const snippet = provider === "brave" ? row.description
                : Array.isArray(row.highlights) ? row.highlights.filter((value) => typeof value === "string").join(" ") : "";
            return { title: row.title, url: row.url, snippet: typeof snippet === "string" ? snippet : "" };
        });
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof SearchError) throw error;
        throw new SearchError(`${NAMES[provider]} search request failed. Check the network connection and try again.`);
    }
}

async function readBody(response: Response, name: string): Promise<string> {
    if (!response.body) throw new SearchError(`${name} search returned an empty response.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 1_048_576) {
                await reader.cancel();
                throw new SearchError(`${name} search response exceeded 1 MiB.`);
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    } finally { reader.releaseLock(); }
}

export function boundedResult(title: string, address: string, snippet: string): SearchResult | undefined {
    let url: URL;
    try { url = new URL(address); } catch { throw new SearchError("Search returned an invalid result URL."); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || address.length > 4_000) return undefined;
    return { title: title.replace(/\s+/g, " ").trim().slice(0, 500), url: address,
        snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 2_000) };
}
function object(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
