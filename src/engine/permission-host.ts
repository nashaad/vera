export function urlHost(raw: string): string | undefined {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return undefined;
    }
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    return host.length === 0 ? undefined : host;
}

export function isHostPattern(value: unknown): value is string {
    if (typeof value !== "string") {
        return false;
    }
    const wildcard = value.startsWith("*.");
    const name = wildcard ? value.slice(2) : value;
    if (
        name.length === 0
        || /[*/\\\s@?#]/.test(name)
        || name.startsWith(".")
        || name.endsWith(".")
        || name.includes("..")
        || (wildcard && name.startsWith("["))
    ) {
        return false;
    }
    // Reject anything URL parsing would rewrite (IDN, numeric IPv4 forms, ports).
    let parsed: string;
    try {
        parsed = new URL(`http://${name}/`).hostname;
    } catch {
        return false;
    }
    return parsed === name.toLowerCase();
}

export function hostMatches(
    pattern: string,
    host: string | undefined,
): boolean {
    if (host === undefined) {
        return false;
    }
    const wanted = pattern.toLowerCase();
    if (wanted.startsWith("*.")) {
        const suffix = wanted.slice(1);
        return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === wanted;
}
