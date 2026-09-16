import { Parser } from "htmlparser2";

export const SEARCH_PROVIDERS = ["brave", "exa", "duckduckgo"] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export const PROVIDER_NAMES: Record<SearchProvider, string> = {
    brave: "Brave", exa: "Exa", duckduckgo: "DuckDuckGo",
};
export const PROVIDER_ENV: Partial<Record<SearchProvider, string>> = {
    brave: "BRAVE_API_KEY", exa: "EXA_API_KEY",
};
export interface SearchResult {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
}
export type SearchFetch = (input: URL, init: RequestInit) => Promise<Response>;
export class SearchError extends Error {}

export async function searchProvider(
    provider: SearchProvider, query: string, count: number, key: string | undefined,
    signal: AbortSignal, fetcher: SearchFetch = fetch,
): Promise<readonly SearchResult[]> {
    const url = new URL(provider === "brave" ? "https://api.search.brave.com/res/v1/web/search"
        : provider === "exa" ? "https://api.exa.ai/search" : "https://lite.duckduckgo.com/lite/");
    let init: RequestInit;
    if (provider === "brave") {
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(count));
        url.searchParams.set("text_decorations", "false");
        init = { headers: { Accept: "application/json", "X-Subscription-Token": key! } };
    } else if (provider === "exa") {
        init = {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": key! },
            body: JSON.stringify({ query, numResults: count, type: "auto", contents: { highlights: { maxCharacters: 2_000 } } }),
        };
    } else {
        url.searchParams.set("q", query);
        init = { headers: { Accept: "text/html" } };
    }
    try {
        const response = await fetcher(url, { ...init, signal, redirect: "error" });
        if (!response.ok) {
            await response.body?.cancel();
            const advice = response.status === 401 || response.status === 403
                ? ` Check ${PROVIDER_ENV[provider] ?? "access"} and its search subscription.`
                : response.status === 429 || response.status === 402
                    ? " Rate or quota limit reached. Try later or check your subscription."
                    : " Try again later.";
            throw new SearchError(`${PROVIDER_NAMES[provider]} search failed with HTTP ${response.status}.${advice}`);
        }
        const text = await readBody(response, provider);
        if (provider === "duckduckgo") return parseDuckDuckGo(text, count);
        let body: unknown;
        try { body = JSON.parse(text); }
        catch { throw new SearchError(`${PROVIDER_NAMES[provider]} search returned invalid JSON.`); }
        const record = object(body);
        if (provider === "brave" && record?.type !== "search") {
            throw new SearchError("Brave search returned an invalid response.");
        }
        const raw = provider === "brave"
            ? record?.web == null ? [] : object(record.web)?.results
            : record?.results;
        if (!Array.isArray(raw)) throw new SearchError(`${PROVIDER_NAMES[provider]} search returned invalid results.`);
        return raw.flatMap((item): SearchResult[] => {
            const row = object(item);
            if (typeof row?.title !== "string" || !row.title.trim() || typeof row.url !== "string") {
                throw new SearchError(`${PROVIDER_NAMES[provider]} search returned an invalid result.`);
            }
            const snippet = provider === "brave" ? row.description
                : Array.isArray(row.highlights) ? row.highlights.filter((value) => typeof value === "string").join(" ") : "";
            const result = boundedResult(row.title, row.url, typeof snippet === "string" ? snippet : "");
            return result ? [result] : [];
        }).slice(0, count);
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof SearchError) throw error;
        throw new SearchError(`${PROVIDER_NAMES[provider]} search request failed. Check the network connection and try again.`);
    }
}

async function readBody(response: Response, provider: SearchProvider): Promise<string> {
    if (!response.body) throw new SearchError(`${PROVIDER_NAMES[provider]} search returned an empty response.`);
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
                throw new SearchError(`${PROVIDER_NAMES[provider]} search response exceeded 1 MiB.`);
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    } finally { reader.releaseLock(); }
}

export function parseDuckDuckGo(html: string, count: number): readonly SearchResult[] {
    const links: { url: string; title: string }[] = [];
    const snippets: string[] = [];
    let link: { url: string; title: string } | undefined;
    let snippet: string | undefined;
    let empty = false;
    let blocked = false;
    const parser = new Parser({
        onopentag(name, attributes) {
            const classes = (attributes.class ?? "").split(/\s+/);
            if (classes.some((value) => value.startsWith("anomaly")) || attributes.id === "challenge-form") blocked = true;
            if (classes.includes("no-results") || classes.includes("no-results__message")) empty = true;
            if (name === "a" && classes.includes("result-link")) link = { url: attributes.href ?? "", title: "" };
            if (name === "td" && classes.includes("result-snippet")) snippet = "";
        },
        ontext(text) {
            if (link) link.title += text;
            if (snippet !== undefined) snippet += text;
        },
        onclosetag(name) {
            if (name === "a" && link) { links.push(link); link = undefined; }
            if (name === "td" && snippet !== undefined) { snippets.push(snippet); snippet = undefined; }
        },
    });
    parser.end(html);
    if (blocked) throw new SearchError("DuckDuckGo blocked the search request.");
    if (links.length === 0 && !empty) throw new SearchError("DuckDuckGo returned no parseable results; the request may be blocked.");
    return links.flatMap((link, index): SearchResult[] => {
        let url: URL;
        try { url = new URL(link.url, "https://duckduckgo.com"); } catch { return []; }
        if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
            try { url = new URL(url.searchParams.get("uddg") ?? ""); } catch { return []; }
        }
        if (url.hostname === "duckduckgo.com" && ["/y.js", "/c/"].includes(url.pathname)) return [];
        const result = boundedResult(link.title, url.href, snippets[index] ?? "");
        return result ? [result] : [];
    }).slice(0, count);
}

function boundedResult(title: string, address: string, snippet: string): SearchResult | undefined {
    let url: URL;
    try { url = new URL(address); } catch { throw new SearchError("Search returned an invalid result URL."); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || address.length > 4_000) return undefined;
    return { title: title.replace(/\s+/g, " ").trim().slice(0, 500), url: address,
        snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 2_000) };
}
function object(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
