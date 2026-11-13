import { ANNEX_BUILT_IN_PAGES } from "../../../src/annex/built-in-pages.ts";
import { readAnnexUrlThroughHost } from "../../../src/annex/host-client.ts";
import type { AnnexPage, AnnexPagesResult } from "../../ui/src/protocol/bridge.ts";

const HOST_TIMEOUT_MS = 5_000;
const PAGES_TIMEOUT_MS = 5_000;
// One entry per page an enabled extension adds; more than this is a reply this client refuses.
const MAX_PAGES = 200;
const MAX_LABEL_CHARS = 200;
const MAX_PATH_CHARS = 2_000;
// The annex only answers requests that name a loopback host, so only those are framed.
const ANNEX_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const EXTENSION_PAGE_PATH = /^\/x\/[^/?#]+\/[^/?#]+$/;

type Fields = Record<string, unknown>;

const BUILT_IN: readonly AnnexPage[] = ANNEX_BUILT_IN_PAGES.map((page) => ({ label: page.label, path: page.href, about: page.about }));

export async function readAnnexPages(socketPath: string | undefined): Promise<AnnexPagesResult> {
    if (socketPath === undefined) return { ok: false, reason: "The host is not running." };
    try {
        const annex = await readAnnexUrlThroughHost(socketPath, HOST_TIMEOUT_MS);
        if ("unavailable" in annex) return { ok: false, reason: annex.unavailable };
        const url = annexBase(annex.url);
        if (url === undefined) return { ok: false, reason: `The host named an annex at ${annex.url}, which this window does not open.` };
        const listed = await readExtensionPages(url);
        return "pages" in listed
            ? { ok: true, url, pages: [...BUILT_IN, ...listed.pages] }
            : { ok: true, url, pages: BUILT_IN, extensionsFailure: listed.failure };
    } catch (error) {
        return { ok: false, reason: error instanceof Error && error.message.length > 0 ? error.message : "The host did not answer." };
    }
}

// The base URL with a trailing slash, or undefined for anything but plain http on a loopback host.
export function annexBase(value: string): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "http:" || !ANNEX_HOSTS.has(parsed.hostname) || parsed.port === "") return undefined;
    return `${parsed.origin}/`;
}

// The full address of an annex path, or undefined when the text is not a path on the annex.
export function annexAddress(base: string, path: unknown): string | undefined {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > MAX_PATH_CHARS) return undefined;
    const address = new URL(path, base);
    return address.origin === new URL(base).origin ? address.href : undefined;
}

async function readExtensionPages(base: string): Promise<{ readonly pages: readonly AnnexPage[] } | { readonly failure: string }> {
    try {
        const response = await fetch(new URL("api/pages", base), { signal: AbortSignal.timeout(PAGES_TIMEOUT_MS) });
        if (!response.ok) return { failure: `The annex answered ${response.status} for its page list.` };
        const body: unknown = await response.json();
        const pages = isFields(body) ? parseExtensionPages(body.pages) : undefined;
        return pages === undefined ? { failure: "The annex sent a page list this window could not read." } : { pages };
    } catch (error) {
        return { failure: error instanceof Error && error.message.length > 0 ? error.message : "The annex did not list its pages." };
    }
}

export function parseExtensionPages(value: unknown): readonly AnnexPage[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_PAGES) return undefined;
    const pages: AnnexPage[] = [];
    for (const entry of value) {
        if (!isFields(entry) || typeof entry.label !== "string" || typeof entry.href !== "string" || typeof entry.extensionId !== "string") return undefined;
        if (!EXTENSION_PAGE_PATH.test(entry.href)) return undefined;
        pages.push({
            label: entry.label.slice(0, MAX_LABEL_CHARS),
            path: entry.href,
            extensionId: entry.extensionId.slice(0, MAX_LABEL_CHARS),
        });
    }
    return pages;
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
