import type { VeraExtensionStorage } from "./extensions.ts";
import type { JsonValue } from "./hooks.ts";

/** One top-level markdown block. Each list item is its own `list_item` block. */
export interface VeraMarkdownBlock {
    readonly kind: string;
    readonly text: string;
    /** Raw HTML in the source is escaped and unsafe link schemes are dropped. */
    readonly html: string;
}

export type VeraAnnexRouteHandler = (
    request: Request,
    url: URL,
) => Response | Promise<Response>;

/** What a page's `server` module receives inside the annex process. */
export interface VeraAnnexPageApi {
    readonly extensionId: string;
    readonly pageId: string;
    readonly storage: VeraExtensionStorage;
    /** Serves `<page>/api/<path>`. Requests other than GET must come from the page itself. */
    route(path: string, handler: VeraAnnexRouteHandler): void;
    markdownBlocks(markdown: string): readonly VeraMarkdownBlock[];
    readonly host: VeraAnnexPageHost;
}

/** Calls a handler this page's own extension registered with `vera.requests.handle`. */
export interface VeraAnnexPageHost {
    /** Rejects with the handler's error message, or after 30 seconds without a signal. */
    request(name: string, payload?: JsonValue, signal?: AbortSignal): Promise<JsonValue>;
}

export interface VeraAnnexPageModule {
    activatePage(page: VeraAnnexPageApi): void | Promise<void>;
}

/** What a page's `browser` module's `mount(root, context)` receives. */
export interface VeraAnnexBrowserContext {
    /** Absolute path prefix for this page's routes, ending in `/`. */
    readonly api: string;
    /** This page's own path, for links within it. */
    readonly page: string;
}
