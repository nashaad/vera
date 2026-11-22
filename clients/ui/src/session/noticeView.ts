import { isAnnexPath, pageAtOrPath } from "../browser/address.ts";
import { annexLink, splitAddresses, type AnnexLink } from "../pagepane/links.ts";
import { pagePathWithQuery } from "../pagepane/notices.ts";
import type { AnnexPagesAnswer } from "../protocol/bridge.ts";
import type { ToolNoticePresentation } from "./model.ts";

export type NoticeView =
    // `open` is undefined while the window has not read the annex's pages, so the card cannot open yet.
    | { readonly kind: "card"; readonly title: string; readonly open: AnnexLink | undefined }
    | { readonly kind: "text"; readonly text: string };

// Notices written before a link came with them name an artifact in the address's query.
const LEGACY_TITLE_FIELD = "artifact";

// A notice with a link is a card that opens its page. An older notice whose text holds an annex address
// is a card too, titled by what the address names. Any other notice is its text.
export function noticeView(notice: ToolNoticePresentation, annex: AnnexPagesAnswer | undefined): NoticeView {
    if (notice.link !== undefined) {
        if (annex === undefined) return { kind: "card", title: notice.link.title, open: undefined };
        const link = notice.link;
        if (!isAnnexPath(link.page)) return { kind: "text", text: notice.text };
        const page = pageAtOrPath(link.page, annex.pages);
        const path = pagePathWithQuery(page, link.query);
        return { kind: "card", title: link.title, open: { page, path } };
    }
    for (const part of splitAddresses(notice.text)) {
        if (part.kind !== "url") continue;
        const link = annexLink(part.url, annex);
        if (link === undefined) continue;
        const named = new URL(part.url).searchParams.get(LEGACY_TITLE_FIELD);
        return { kind: "card", title: named === null || named === "" ? link.page.label : named, open: link };
    }
    return { kind: "text", text: notice.text };
}
