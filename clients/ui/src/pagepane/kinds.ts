import { ANNEX_BUILT_IN_PAGES } from "../../../../src/annex/built-in-pages.ts";
import type { AnnexPage } from "../protocol/bridge.ts";
import type { PaneKind } from "../registry/core.ts";

// The most tabs one extension page keeps open in the right pane.
export const PAGE_TAB_LIMIT = 3;
// The most extension pages that get a pane; a host that lists more is cut here.
export const PAGE_KIND_LIMIT = 8;

const PAGE_KIND_PREFIX = "page:";
export const GENERIC_PAGE_KIND = "page.generic";

// A pane kind is named by its page's annex path, so one page is one kind whatever lists it.
export function pageKindId(path: string): string {
    return `${PAGE_KIND_PREFIX}${path}`;
}

export function pagePathOfKind(kind: string): string | undefined {
    const path = kind.startsWith(PAGE_KIND_PREFIX) ? kind.slice(PAGE_KIND_PREFIX.length) : undefined;
    return path?.startsWith("/") ? path : undefined;
}

export function builtInPages(pages: readonly AnnexPage[]): readonly AnnexPage[] {
    return ANNEX_BUILT_IN_PAGES.map((builtin) => pages.find((page) => page.path === builtin.href) ?? {
        label: builtin.label,
        path: builtin.href,
    });
}

// Extension panes have their own cap. Built-in page kinds do not count toward it.
export function extensionPages(pages: readonly AnnexPage[]): readonly AnnexPage[] {
    return pages.filter((page) => page.pane === true && page.extensionId !== undefined).slice(0, PAGE_KIND_LIMIT);
}

export function panePages(pages: readonly AnnexPage[]): readonly AnnexPage[] {
    return [...builtInPages(pages), ...extensionPages(pages)];
}

// Dedicated page tabs are saved with the layout; generic page tabs are temporary.
export function pageKinds(pages: readonly AnnexPage[]): readonly PaneKind[] {
    return [
        ...panePages(pages).map((page) => ({
            id: pageKindId(page.path),
            title: page.label,
            icon: "page",
            maxTabs: PAGE_TAB_LIMIT,
        })),
        { id: GENERIC_PAGE_KIND, title: "Page", icon: "page", transientTabs: true },
    ];
}

export function sameKinds(left: readonly PaneKind[], right: readonly PaneKind[]): boolean {
    return left.length === right.length && left.every((kind, index) => kind.id === right[index]?.id && kind.title === right[index]?.title);
}
