/**
 * A path appended to a provider's base URL, without losing what the base
 * carries.
 *
 * A base URL is not always just a host. A gateway hands out one with a path
 * prefix and often a query, and `${base}${path}` puts the path after the query
 * string, which produces a URL nobody meant and a request nobody can debug
 * from the error. Parsing it is the only join that survives those.
 *
 * An unparseable base is returned joined as written: it is the user's string,
 * and the request that fails says so more clearly than a silent rewrite would.
 */
export function providerEndpointUrl(baseUrl: string, path: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    try {
        const url = new URL(trimmed);
        url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
        return url.toString();
    } catch {
        return `${trimmed}${suffix}`;
    }
}
