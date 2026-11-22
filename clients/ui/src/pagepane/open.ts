import type { LayoutAction } from "../layout/reducer.ts";
import { canOpenTab, findContainer, type ResolvedLayout } from "../layout/resolve.ts";
import { showToast } from "../overlays/toasts.ts";
import type { AnnexPage } from "../protocol/bridge.ts";
import { GENERIC_PAGE_KIND, pageKindId } from "./kinds.ts";
import { pageTabs } from "./store.ts";

// What opening a page reads and changes; the workbench provides both.
export interface PageHost {
    readonly layout: ResolvedLayout;
    readonly dispatch: (action: LayoutAction) => void;
}

export function pageTabsFull(title: string): string {
    return `Close a tab in the right pane to open ${title}.`;
}

export function newPageTabId(): string {
    return `tab.page-${crypto.randomUUID().slice(0, 8)}`;
}

export type PageOpen = "opened" | "shown" | "full";

// Shows `path` (the page's annex path, with any query) in a tab of the page's own pane: the tab already on it, a new tab
// while there is room, else the last tab of the pane. Opens the right pane if it was closed and never moves keyboard focus.
export function openPageTab(host: PageHost, page: AnnexPage, path: string): PageOpen {
    const kind = pageKindId(page.path);
    const tabs = host.layout.locations.rightPane.tabs.filter((tab) => tab.container.id === kind);
    const same = tabs.find((tab) => (pageTabs.get(tab.id) ?? page.path) === path);
    if (same !== undefined) {
        host.dispatch({ type: "activateTab", tab: same.id });
        return "shown";
    }
    if (canOpenTab(host.layout, kind)) {
        const id = newPageTabId();
        pageTabs.show(id, path);
        host.dispatch({ type: "openTab", container: kind, tab: id });
        return "opened";
    }
    const last = tabs.at(-1);
    if (last === undefined) return "full";
    pageTabs.show(last.id, path);
    host.dispatch({ type: "activateTab", tab: last.id });
    return "shown";
}

export function openAnnexPath(host: PageHost, page: AnnexPage, path: string): void {
    const own = findContainer(host.layout, pageKindId(page.path));
    if (own !== undefined && own.shown && own.location === "rightPane") {
        if (openPageTab(host, page, path) === "full") showToast(pageTabsFull(page.label), "danger");
        return;
    }
    const tabs = host.layout.locations.rightPane.tabs.filter((tab) => tab.container.id === GENERIC_PAGE_KIND);
    const same = tabs.find((tab) => pageTabs.get(tab.id) === path);
    if (same !== undefined) {
        host.dispatch({ type: "activateTab", tab: same.id });
    } else if (canOpenTab(host.layout, GENERIC_PAGE_KIND)) {
        const id = newPageTabId();
        pageTabs.show(id, path);
        host.dispatch({ type: "openTab", container: GENERIC_PAGE_KIND, tab: id });
    } else {
        showToast(pageTabsFull(page.label), "danger");
    }
}
