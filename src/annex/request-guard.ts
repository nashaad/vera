// Every request must name one of these hosts. A request that can change state
// and carries an Origin must come from the annex's own origin.
export const ANNEX_HOSTNAMES: readonly string[] = [
    "127.0.0.1",
    "localhost",
    "vera.localhost",
    "[::1]",
];

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function refuseForeignRequest(
    request: Request,
    port: number,
): Response | undefined {
    const host = request.headers.get("host");
    if (host === null || !isAnnexHost(host)) {
        return new Response(
            "This annex answers only at 127.0.0.1, localhost and vera.localhost.\n",
            { status: 421 },
        );
    }
    if (SAFE_METHODS.has(request.method)) {
        return undefined;
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !isAnnexOrigin(origin, port)) {
        return new Response("The annex refuses requests from other sites.\n", {
            status: 403,
        });
    }
    return undefined;
}

function isAnnexHost(host: string): boolean {
    const parsed = parseUrl(`http://${host}`);
    return parsed !== undefined && ANNEX_HOSTNAMES.includes(parsed.hostname);
}

function isAnnexOrigin(origin: string, port: number): boolean {
    const parsed = parseUrl(origin);
    return parsed !== undefined
        && parsed.protocol === "http:"
        && ANNEX_HOSTNAMES.includes(parsed.hostname)
        && parsed.port === String(port);
}

function parseUrl(text: string): URL | undefined {
    try {
        return new URL(text);
    } catch {
        return undefined;
    }
}
