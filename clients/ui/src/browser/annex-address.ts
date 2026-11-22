import { openAnnexPath, type PageHost } from "../pagepane/open.ts";
import type { AnnexPagesAnswer } from "../protocol/bridge.ts";
import { isAnnexPath, pageAtOrPath, resolveAddress } from "./address.ts";
import { isLoopbackHost } from "./loopback.ts";
import { browserUrl } from "./url.ts";

const MAX_ANNEX_PATH = 2_000;

export function openAnnexAddress(host: PageHost, annex: AnnexPagesAnswer | undefined, value: string): boolean {
    const path = resolveAddress(value, annex?.url);
    if (!isAnnexPath(path)) {
        if (annex !== undefined) return false;
        const url = browserUrl(value);
        return url !== undefined && isLoopbackHost(new URL(url).hostname);
    }
    if (annex === undefined || path.length > MAX_ANNEX_PATH) return true;
    openAnnexPath(host, pageAtOrPath(path, annex.pages), path);
    return true;
}
