export const URL_LIMIT = 8192;

// The web address typed text names, or undefined when it is not one a browser page can open.
export function browserUrl(value: string): string | undefined {
    if (value.length > URL_LIMIT) return undefined;
    const text = value.trim();
    if (text === "") return undefined;
    try {
        if (/^[a-z][a-z0-9+.-]*:(?!\/\/|[0-9])/i.test(text)) return undefined;
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

// Like browserUrl, but only for text that reads as an address rather than a word: it has a scheme,
// a dot, a port or is localhost. A launcher uses it so that typing "fi" still filters.
export function typedAddress(value: string): string | undefined {
    const href = browserUrl(value);
    if (href === undefined) return undefined;
    const url = new URL(href);
    const explicit = /^https?:\/\//i.test(value.trim());
    const named = url.hostname.includes(".") || url.hostname === "localhost" || url.hostname.startsWith("[");
    return explicit || named || url.port !== "" ? href : undefined;
}
