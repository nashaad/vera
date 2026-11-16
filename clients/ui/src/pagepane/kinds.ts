import type { AnnexPage } from "../protocol/bridge.ts";
import type { PaneKind } from "../registry/core.ts";

// The most tabs one extension page keeps open in the right pane.
export const PAGE_TAB_LIMIT = 3;
// The most extension pages that get a pane; a host that lists more is cut here.
export const PAGE_KIND_LIMIT = 8;

const PAGE_KIND_PREFIX = "page:";

// A pane kind is named by its page's annex path, so one page is one kind whatever lists it.
export function pageKindId(path: string): string {
    return `${PAGE_KIND_PREFIX}${path}`;
}

export function pagePathOfKind(kind: string): string | undefined {
    const path = kind.startsWith(PAGE_KIND_PREFIX) ? kind.slice(PAGE_KIND_PREFIX.length) : undefined;
    return path?.startsWith("/") ? path : undefined;
}

// The pages an extension gave their own pane, which the pane kinds and the sidebar both list. Vera's own pages never have one.
export function extensionPages(pages: readonly AnnexPage[]): readonly AnnexPage[] {
    return pages.filter((page) => page.pane === true && page.extensionId !== undefined).slice(0, PAGE_KIND_LIMIT);
}

// One kind for each of those pages. Its tabs are saved with the layout.
export function pageKinds(pages: readonly AnnexPage[]): readonly PaneKind[] {
    return extensionPages(pages)
        .map((page) => ({
            id: pageKindId(page.path),
            title: page.label,
            icon: "page",
            maxTabs: PAGE_TAB_LIMIT,
        }));
}

export function sameKinds(left: readonly PaneKind[], right: readonly PaneKind[]): boolean {
    return left.length === right.length && left.every((kind, index) => kind.id === right[index]?.id && kind.title === right[index]?.title);
}
