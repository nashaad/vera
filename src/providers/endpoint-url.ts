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

// A URL the user wrote for their own provider: any http or https host. Config load and provider
// resolution must both use this, or a saved provider can load and then fail to resolve.
export function isUserProviderUrl(value: string): boolean {
    try {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}
