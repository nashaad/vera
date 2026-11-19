import type { NoticeLink } from "../session/model.ts";
import type { AnnexPage, AnnexPagesAnswer } from "../protocol/bridge.ts";
import { tabDots } from "../workbench/tabDots.ts";
import { canOpenTab } from "../layout/resolve.ts";
import type { PageHost } from "./open.ts";
import { pageKindId, panePages } from "./kinds.ts";
import { pageTabs } from "./store.ts";

// A page's annex path with the query a link carries.
export function pagePathWithQuery(page: AnnexPage, query: NoticeLink["query"]): string {
    const text = new URLSearchParams(query ?? {}).toString();
    return text === "" ? page.path : `${page.path}?${text}`;
}

export interface NoticeTarget {
    readonly page: AnnexPage;
    // The page's annex path with the link's query.
    readonly path: string;
}

// The page a notice's link names, as the annex lists it. Pages without an app pane are not targets.
export function noticeTarget(link: NoticeLink, annex: AnnexPagesAnswer | undefined): NoticeTarget | undefined {
    if (annex === undefined) return undefined;
    const page = panePages(annex.pages).find((candidate) => candidate.path === link.page);
    if (page === undefined) return undefined;
    return { page, path: pagePathWithQuery(page, link.query) };
}

// A new link to a page with a pane: makes sure the page has a tab in the right pane without taking the pane's
// current tab away or opening a hidden pane, and marks the page's tab as changed while it is not the shown one.
// An existing tab keeps the address it shows.
export function noticePage(host: PageHost, target: NoticeTarget): void {
    const kind = pageKindId(target.page.path);
    const pane = host.layout.locations.rightPane;
    const tabs = pane.tabs.filter((tab) => tab.container.id === kind);
    let shown = pane.visible && pane.activeTab?.container.id === kind;
    if (tabs.length === 0) {
        if (!canOpenTab(host.layout, kind)) return;
        // One id per page, so a second notice before the layout updates asks for the same tab and changes nothing.
        const id = `tab.page-notice-${target.page.path}`;
        if (pageTabs.get(id) === undefined) pageTabs.show(id, target.path);
        host.dispatch({ type: "openTab", container: kind, tab: id, background: true });
        // A pane that showed no tab shows the new one.
        shown = pane.visible && pane.activeTab === undefined;
    }
    if (!shown) tabDots.mark(kind);
}
