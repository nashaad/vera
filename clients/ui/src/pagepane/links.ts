import { isAnnexPath, pageAtOrPath, resolveAddress } from "../browser/address.ts";
import type { AnnexPage, AnnexPagesAnswer } from "../protocol/bridge.ts";

export interface AnnexLink {
    readonly page: AnnexPage;
    // The annex path the link names, with its query.
    readonly path: string;
}

// Full loopback addresses with a port, the only bare text that can name the annex.
export const ANNEX_ADDRESS = String.raw`https?:\/\/(?:127\.0\.0\.1|localhost|vera\.localhost|\[::1\]):\d+\/[^\s<>"'\x60)\]]*`;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

// Only full addresses on this host's annex are page links.
export function annexLink(address: string, annex: AnnexPagesAnswer | undefined): AnnexLink | undefined {
    if (annex === undefined || !/^https?:\/\//.test(address)) return undefined;
    const path = resolveAddress(address, annex.url);
    if (!isAnnexPath(path)) return undefined;
    return { page: pageAtOrPath(path, annex.pages), path };
}

export type TextPart =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "url"; readonly url: string };

// Splits text around the loopback addresses in it, leaving punctuation that ends a sentence outside the address.
export function splitAddresses(text: string): readonly TextPart[] {
    const parts: TextPart[] = [];
    let last = 0;
    for (const match of text.matchAll(new RegExp(ANNEX_ADDRESS, "g"))) {
        const at = match.index ?? 0;
        const url = match[0].replace(TRAILING_PUNCTUATION, "");
        if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
        parts.push({ kind: "url", url });
        last = at + url.length;
    }
    if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
    return parts;
}
