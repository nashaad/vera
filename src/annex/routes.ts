/**
 * Annex HTTP routes. A new page is another entry here. The host never sees
 * these paths; it only holds the annex base URL.
 */

export interface AnnexRequestContext {
    readonly request: Request;
    readonly url: URL;
}

export interface AnnexRoute {
    readonly match: (pathname: string) => boolean;
    readonly handle: (
        context: AnnexRequestContext,
    ) => Promise<Response> | Response;
}

export function exactRoute(
    path: string,
    handle: AnnexRoute["handle"],
): AnnexRoute {
    return {
        match: (pathname) => pathname === path,
        handle,
    };
}

export function prefixRoute(
    prefix: string,
    handle: AnnexRoute["handle"],
): AnnexRoute {
    return {
        match: (pathname) => pathname.startsWith(prefix),
        handle,
    };
}

export function dispatchAnnexRoute(
    routes: readonly AnnexRoute[],
    request: Request,
): Promise<Response> | Response {
    const url = new URL(request.url);
    for (const route of routes) {
        if (route.match(url.pathname)) {
            return route.handle({ request, url });
        }
    }
    return new Response("Not found", { status: 404 });
}
