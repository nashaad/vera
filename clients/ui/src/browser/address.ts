import type { AnnexPage } from "../protocol/bridge.ts";
import { isLoopbackHost } from "./loopback.ts";

export function isAnnexPath(entry: string): boolean {
    return entry.startsWith("/") && !entry.startsWith("//");
}

export function resolveAddress(text: string, base: string | undefined): string {
    const address = text.trim();
    if (address === "" || isAnnexPath(address) || base === undefined) return address;
    try {
        const annex = new URL(base);
        const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`);
        if (url.protocol === annex.protocol && url.port === annex.port && isLoopbackHost(annex.hostname) && isLoopbackHost(url.hostname)) {
            return `${url.pathname}${url.search}${url.hash}`;
        }
    } catch {
        return address;
    }
    return address;
}

// The listed page an annex path belongs to: its own path, or a query or hash on it.
export function pageAt(path: string, pages: readonly AnnexPage[]): AnnexPage | undefined {
    const bare = path.replace(/[?#].*$/, "").replace(/(.)\/+$/, "$1");
    return pages.find((page) => page.path === bare);
}
