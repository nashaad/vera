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
