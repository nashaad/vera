export interface SearchResult {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
}

type Fetch = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export async function searchDuckDuckGo(
    query: string,
    maxResults: number,
    signal: AbortSignal,
    fetcher: Fetch = fetch,
): Promise<readonly SearchResult[]> {
    const endpoint = "https://lite.duckduckgo.com/lite/";
    const initial = await fetcher(endpoint, {
        headers: browserHeaders(),
        signal,
    });
    if (!initial.ok) {
        throw new Error(
            `DuckDuckGo search setup failed with HTTP ${initial.status}`,
        );
    }
    const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
            ...browserHeaders(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            q: query,
            kl: "wt-wt",
        }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`);
    }
    const results = parseDuckDuckGoLite(await response.text(), maxResults);
    if (results.length === 0) {
        throw new Error(
            "DuckDuckGo returned no parseable results; it may have blocked the request.",
        );
    }
    return results;
}

export function parseDuckDuckGoLite(
    html: string,
    maxResults: number,
): readonly SearchResult[] {
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
        .flatMap((match) => {
            const attributes = match[1] ?? "";
            return hasClass(attributes, "result-link")
                ? [{
                    url: attribute(attributes, "href") ?? "",
                    title: match[2] ?? "",
                }]
                : [];
        });
    const snippets = [...html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
        .flatMap((match) =>
            hasClass(match[1] ?? "", "result-snippet")
                ? [match[2] ?? ""]
                : []
        );
    return links.slice(0, maxResults).flatMap((link, index) => {
        const url = cleanDuckDuckGoUrl(decodeHtml(link.url));
        const title = plainText(link.title);
        if (url.length === 0 || title.length === 0 || isAdvertisement(url)) {
            return [];
        }
        return [{
            title,
            url,
            snippet: plainText(snippets[index] ?? ""),
        }];
    });
}

function hasClass(attributes: string, expected: string): boolean {
    return (attribute(attributes, "class") ?? "")
        .split(/\s+/)
        .includes(expected);
}

function attribute(attributes: string, name: string): string | undefined {
    const match = new RegExp(
        `(?:^|\\s)${name}=(["'])(.*?)\\1`,
        "i",
    ).exec(attributes);
    return match?.[2];
}

function browserHeaders(): Record<string, string> {
    return {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            + "AppleWebKit/537.36 Chrome/124 Safari/537.36",
    };
}

function cleanDuckDuckGoUrl(value: string): string {
    if (!value.startsWith("/l/?")) {
        return value;
    }
    const redirect = new URL(value, "https://duckduckgo.com");
    return redirect.searchParams.get("uddg") ?? "";
}

function isAdvertisement(url: string): boolean {
    return url.includes("duckduckgo.com/y.js")
        || url.includes("duckduckgo.com/c/");
}

function plainText(value: string): string {
    return decodeHtml(value.replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}

function decodeHtml(value: string): string {
    const named: Readonly<Record<string, string>> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: "\"",
        nbsp: " ",
    };
    return value.replace(
        /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
        (_match, entity: string) => {
            if (entity.startsWith("#x")) {
                return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
            }
            if (entity.startsWith("#")) {
                return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
            }
            return named[entity.toLowerCase()] ?? `&${entity};`;
        },
    );
}
