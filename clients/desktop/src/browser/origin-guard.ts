import { isLoopbackHost } from "../../../ui/src/browser/loopback.ts";

export const BLOCKED_ANNEX_OPEN_ERROR = "Vera pages cannot be opened in the Browser pane.";

function parsedNetworkUrl(value: string): URL | undefined {
    try {
        const url = new URL(value);
        return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) ? url : undefined;
    } catch {
        return undefined;
    }
}

export class BrowserOriginGuard {
    private annex: URL | undefined;

    setAnnexUrl(value: string | undefined): void {
        const parsed = value === undefined ? undefined : parsedNetworkUrl(value);
        this.annex = parsed !== undefined && (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname)
            ? parsed
            : undefined;
    }

    blocks(value: string): boolean {
        const url = parsedNetworkUrl(value);
        if (url === undefined || !isLoopbackHost(url.hostname)) return false;
        if (this.annex === undefined) return true;
        const protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
        return protocol === this.annex.protocol && url.port === this.annex.port;
    }
}
