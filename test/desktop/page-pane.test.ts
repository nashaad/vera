import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { defaultLayout, MAX_TABS, type LayoutState } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout, type LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { canOpenTab, resolveLayout, type ResolvedLayout } from "../../clients/ui/src/layout/resolve.ts";
import { currentToasts } from "../../clients/ui/src/overlays/toasts.ts";
import { annexLink, splitAddresses } from "../../clients/ui/src/pagepane/links.ts";
import { noticePage, noticeTarget } from "../../clients/ui/src/pagepane/notices.ts";
import { openAnnexAddress } from "../../clients/ui/src/browser/annex-address.ts";
import { extensionPages, PAGE_KIND_LIMIT, PAGE_TAB_LIMIT, pageKindId, pageKinds, pagePathOfKind, sameKinds } from "../../clients/ui/src/pagepane/kinds.ts";
import { openAnnexPath, openPageTab, pageTabsFull, type PageHost } from "../../clients/ui/src/pagepane/open.ts";
import { pageTabs } from "../../clients/ui/src/pagepane/store.ts";
import { PageLinksProvider } from "../../clients/ui/src/pagepane/PageLinks.tsx";
import type { AnnexPage, AnnexPagesAnswer } from "../../clients/ui/src/protocol/bridge.ts";
import { ContributionRegistry } from "../../clients/ui/src/registry/contributions.ts";
import { CORE_CONTAINERS, PANE_KINDS, registerCoreContributions, registerPaneKind } from "../../clients/ui/src/registry/core.ts";
import { Markdown } from "../../clients/ui/src/session/Markdown.tsx";
import type { ToolCall, ToolNoticePresentation } from "../../clients/ui/src/session/model.ts";
import { noticeView } from "../../clients/ui/src/session/noticeView.ts";
import { RunLine } from "../../clients/ui/src/session/ToolRuns.tsx";
import { forSave, parseLayout } from "../../clients/ui/src/layout/saved.ts";
import { tabDots } from "../../clients/ui/src/workbench/tabDots.ts";
import { WorkbenchContext, type WorkbenchApi } from "../../clients/ui/src/workbench/context.tsx";
import { ExtensionPage } from "../../clients/ui/src/pages/ExtensionPage.tsx";
import { routeTitle, sameRoute, type ExtensionRoute } from "../../clients/ui/src/pages/routes.ts";
import { renderView } from "../../clients/ui/src/views/registry.tsx";

const NEST: AnnexPage = { label: "Nests", path: "/x/vera.nests/nests", extensionId: "vera.nests", pane: true };
const PLAIN: AnnexPage = { label: "Plain", path: "/x/vera.plain/plain", extensionId: "vera.plain" };
const USAGE: AnnexPage = { label: "Usage", path: "/usage" };
const ANNEX: AnnexPagesAnswer = { ok: true, url: "http://127.0.0.1:8372/", pages: [USAGE, NEST, PLAIN] };
const NEST_KIND = pageKindId(NEST.path);
const LINK = { title: "Raid", page: NEST.path, query: { session: "s1", artifact: "raid" } };
const NOTICE_PATH = `${NEST.path}?session=s1&artifact=raid`;

afterEach(() => {
    pageTabs.reset();
    tabDots.reset();
    Reflect.deleteProperty(globalThis, "window");
});

// A layout that re-resolves after every action, the way the window's controller does.
function harness(kinds = pageKinds(ANNEX.pages)) {
    const contributions = new ContributionRegistry();
    registerCoreContributions(contributions);
    for (const kind of kinds) registerPaneKind(contributions, kind);
    let state: LayoutState = defaultLayout();
    const host: PageHost & { layout: ResolvedLayout; state(): LayoutState; contributions: ContributionRegistry } = {
        layout: resolveLayout(state, contributions.snapshot()),
        dispatch: (action: LayoutAction) => {
            state = reduceLayout(state, action, contributions.snapshot());
            host.layout = resolveLayout(state, contributions.snapshot());
        },
        state: () => state,
        contributions,
    };
    return host;
}

const tabsOf = (host: PageHost, kind: string) => host.layout.locations.rightPane.tabs.filter((tab) => tab.container.id === kind);

test("@core built-in pages and extension pages with panes become separate page kinds", () => {
    const kinds = pageKinds(ANNEX.pages);
    expect(kinds).toEqual([
        { id: pageKindId("/usage"), title: "Usage", icon: "page", maxTabs: PAGE_TAB_LIMIT },
        { id: pageKindId("/runs"), title: "Workflow runs", icon: "page", maxTabs: PAGE_TAB_LIMIT },
        { id: NEST_KIND, title: "Nests", icon: "page", maxTabs: PAGE_TAB_LIMIT },
    ]);
    expect(pageKinds([]).map((kind) => kind.title)).toEqual(["Usage", "Workflow runs"]);
    expect(pagePathOfKind(NEST_KIND)).toBe(NEST.path);
    expect(pagePathOfKind(CORE_CONTAINERS.browser)).toBeUndefined();
    expect(pageKinds([{ label: "Other", path: "/other", pane: true }])).toHaveLength(2);
});

test("extension page kinds are capped separately from built-in page kinds", () => {
    const many = Array.from({ length: PAGE_KIND_LIMIT + 4 }, (_, index): AnnexPage => ({
        label: `Page ${index}`,
        path: `/x/vera.many/p${index}`,
        extensionId: "vera.many",
        pane: true,
    }));
    expect(pageKinds(many)).toHaveLength(PAGE_KIND_LIMIT + 2);
    expect(pageKinds([...many, USAGE])).toHaveLength(PAGE_KIND_LIMIT + 2);
    expect(sameKinds(pageKinds(ANNEX.pages), pageKinds([...ANNEX.pages]))).toBe(true);
    expect(sameKinds(pageKinds(ANNEX.pages), [])).toBe(false);
    expect(sameKinds(pageKinds(ANNEX.pages), pageKinds([{ ...NEST, label: "Renamed" }]))).toBe(false);
});

test("@core a page kind registers like a core kind and leaves with its remover, and core names none", () => {
    expect(JSON.stringify(PANE_KINDS).toLowerCase()).not.toContain("artifact");
    expect(PANE_KINDS.some((kind) => pagePathOfKind(kind.id) !== undefined)).toBe(false);
    const contributions = new ContributionRegistry();
    registerCoreContributions(contributions);
    const remove = registerPaneKind(contributions, pageKinds(ANNEX.pages).find((kind) => kind.id === NEST_KIND)!);
    const container = contributions.snapshot().containers.find((candidate) => candidate.id === NEST_KIND);
    expect(container).toMatchObject({ title: "Nests", icon: "page", location: "rightPane", maxTabs: PAGE_TAB_LIMIT });
    expect(contributions.keepsTabsOut(NEST_KIND)).toBe(false);
    remove();
    expect(contributions.snapshot().containers.some((candidate) => candidate.id === NEST_KIND)).toBe(false);
});

test("@core a page kind takes tabs up to its limit and is a launcher entry in the right pane", () => {
    const host = harness();
    expect(host.layout.locations.rightPane.all.map((container) => container.id)).toContain(NEST_KIND);
    for (let index = 0; index < PAGE_TAB_LIMIT + 2; index++) host.dispatch({ type: "openTab", container: NEST_KIND });
    expect(tabsOf(host, NEST_KIND)).toHaveLength(PAGE_TAB_LIMIT);
    expect(canOpenTab(host.layout, NEST_KIND)).toBe(false);
});

test("a view of a page kind draws as that page, and other ids still reach the core views", () => {
    expect(renderView(NEST_KIND, { visible: true })).not.toBeNull();
    expect(renderView("page:not-a-page", { visible: true })).toBeNull();
    expect(renderView("core.unknown", { visible: true })).toBeNull();
});

test("@core opening a page path shows it in a new tab of the page's pane, then reuses a tab on the same path", () => {
    const host = harness();
    expect(openPageTab(host, NEST, `${NEST.path}?id=1`)).toBe("opened");
    expect(host.layout.locations.rightPane.visible).toBe(true);
    const [first] = tabsOf(host, NEST_KIND);
    expect(pageTabs.get(first!.id)).toBe(`${NEST.path}?id=1`);
    expect(host.layout.locations.rightPane.activeTab?.id).toBe(first!.id);

    expect(openPageTab(host, NEST, `${NEST.path}?id=2`)).toBe("opened");
    expect(tabsOf(host, NEST_KIND)).toHaveLength(2);
    expect(openPageTab(host, NEST, `${NEST.path}?id=1`)).toBe("shown");
    expect(tabsOf(host, NEST_KIND)).toHaveLength(2);
    expect(host.layout.locations.rightPane.activeTab?.id).toBe(first!.id);
});

test("at its tab limit a page opens on the pane's last tab instead of adding one", () => {
    const host = harness();
    for (let index = 0; index < PAGE_TAB_LIMIT; index++) openPageTab(host, NEST, `${NEST.path}?id=${index}`);
    expect(openPageTab(host, NEST, `${NEST.path}?id=new`)).toBe("shown");
    const tabs = tabsOf(host, NEST_KIND);
    expect(tabs).toHaveLength(PAGE_TAB_LIMIT);
    expect(pageTabs.get(tabs.at(-1)!.id)).toBe(`${NEST.path}?id=new`);
});

test("@core app pages open in their own kinds and non-pane pages use the system browser", () => {
    const opened: string[] = [];
    Object.assign(globalThis, { window: { veraDesktop: { openAnnexPage: (path: string) => void opened.push(path) } } });
    const host = harness();
    openAnnexPath(host, USAGE, `${USAGE.path}?session=s1`);
    expect(tabsOf(host, pageKindId(USAGE.path))).toHaveLength(1);
    expect(pageTabs.get(tabsOf(host, pageKindId(USAGE.path))[0]!.id)).toBe(`${USAGE.path}?session=s1`);

    openAnnexPath(host, NEST, `${NEST.path}?id=7`);
    expect(tabsOf(host, NEST_KIND)).toHaveLength(1);
    expect(tabsOf(host, CORE_CONTAINERS.browser)).toHaveLength(0);

    openAnnexPath(host, PLAIN, PLAIN.path);
    expect(opened).toEqual([PLAIN.path]);
    expect(tabsOf(host, NEST_KIND)).toHaveLength(1);
});

test("@core annex addresses route by their resolved path, with unknown annex paths using system fallback", () => {
    const opened: string[] = [];
    Object.assign(globalThis, { window: { veraDesktop: { openAnnexPage: (path: string) => void opened.push(path) } } });
    const host = harness();
    expect(openAnnexAddress(host, ANNEX, `${ANNEX.url}usage?session=s1`)).toBe(true);
    const usage = tabsOf(host, pageKindId(USAGE.path))[0];
    expect(usage).toBeDefined();
    expect(pageTabs.get(usage!.id)).toBe("/usage?session=s1");
    expect(openAnnexAddress(host, ANNEX, `${ANNEX.url}unknown?x=1`)).toBe(true);
    expect(opened).toEqual(["/unknown?x=1"]);
    expect(openAnnexAddress(host, ANNEX, "https://example.com/path")).toBe(false);
});

test("@core loopback addresses are blocked until retried after the annex origin is known", () => {
    const opened: string[] = [];
    Object.assign(globalThis, { window: { veraDesktop: { openAnnexPage: (path: string) => void opened.push(path) } } });
    const host = harness();
    for (const address of [
        "http://127.0.0.1:8372/usage",
        "localhost:8372/runs",
        "http://[::1]:8372/usage",
        "http://[::ffff:127.0.0.1]:8372/usage",
        "http://vera.localhost.:8372/usage",
        "http://127.1:8372/usage",
    ]) {
        expect(openAnnexAddress(host, undefined, address)).toBe(true);
    }
    expect(openAnnexAddress(host, undefined, "/usage")).toBe(true);
    expect(openAnnexAddress(host, undefined, "https://example.com/usage")).toBe(false);
    expect(openAnnexAddress(host, undefined, "https://localhost.example.com/usage")).toBe(false);
    expect(host.layout.locations.rightPane.tabs).toHaveLength(0);
    expect(opened).toEqual([]);

    expect(openAnnexAddress(host, ANNEX, "http://127.0.0.1:9999/usage")).toBe(false);
    expect(openAnnexAddress(host, ANNEX, "http://localhost:8372/usage")).toBe(true);
    expect(tabsOf(host, pageKindId(USAGE.path))).toHaveLength(1);
});

test("a page whose kind is not registered opens in the system browser", () => {
    const opened: string[] = [];
    Object.assign(globalThis, { window: { veraDesktop: { openAnnexPage: (path: string) => void opened.push(path) } } });
    const host = harness([]);
    openAnnexPath(host, NEST, NEST.path);
    expect(opened).toEqual([NEST.path]);
});

test("a hidden or moved page kind uses the system browser", () => {
    const opened: string[] = [];
    Object.assign(globalThis, { window: { veraDesktop: { openAnnexPage: (path: string) => void opened.push(path) } } });
    const hidden = harness();
    hidden.dispatch({ type: "setContainerHidden", container: NEST_KIND, hidden: true });
    openAnnexPath(hidden, NEST, `${NEST.path}?id=1`);
    const moved = harness();
    moved.dispatch({ type: "moveContainer", container: NEST_KIND, location: "panel" });
    openAnnexPath(moved, NEST, `${NEST.path}?id=2`);
    expect(opened).toEqual([`${NEST.path}?id=1`, `${NEST.path}?id=2`]);
});

test("a link goes to the system browser when neither pane is available", () => {
    const opened: string[] = [];
    Object.assign(globalThis, { window: { veraDesktop: { openAnnexPage: (path: string) => void opened.push(path) } } });
    const contributions = new ContributionRegistry();
    registerCoreContributions(contributions);
    contributions.setUnavailable(new Set([CORE_CONTAINERS.browser]));
    const state = defaultLayout();
    const host: PageHost = { layout: resolveLayout(state, contributions.snapshot()), dispatch: () => undefined };
    openAnnexPath(host, PLAIN, `${PLAIN.path}?a=1`);
    expect(opened).toEqual([`${PLAIN.path}?a=1`]);
});

test("a page that cannot open because the right pane is full says so in a toast", () => {
    const host = harness();
    for (let index = 0; index < MAX_TABS; index++) host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    expect(host.layout.tabTotal).toBe(MAX_TABS);
    openAnnexPath(host, NEST, NEST.path);
    expect(currentToasts().at(-1)?.text).toBe(pageTabsFull("Nests"));
    expect(tabsOf(host, NEST_KIND)).toHaveLength(0);
});

test("@core only a full address on the host's annex that names a listed page is a page link", () => {
    expect(annexLink("http://127.0.0.1:8372/x/vera.nests/nests?id=1", ANNEX)).toEqual({ page: NEST, path: "/x/vera.nests/nests?id=1" });
    expect(annexLink("http://localhost:8372/usage", ANNEX)?.page).toEqual(USAGE);
    expect(annexLink("http://vera.localhost:8372/usage", ANNEX)?.page).toEqual(USAGE);
    expect(annexLink("http://127.0.0.1:9999/usage", ANNEX)).toBeUndefined();
    expect(annexLink("https://example.com/usage", ANNEX)).toBeUndefined();
    expect(annexLink("http://127.0.0.1:8372/x/vera.nests/missing", ANNEX)).toBeUndefined();
    expect(annexLink("/usage", ANNEX)).toBeUndefined();
    expect(annexLink("Usage", ANNEX)).toBeUndefined();
    expect(annexLink("http://127.0.0.1:8372/usage", undefined)).toBeUndefined();
});

test("an address in running text ends before the punctuation that closes the sentence", () => {
    expect(splitAddresses("Page: http://127.0.0.1:8372/x/vera.nests/nests?id=1. Done")).toEqual([
        { kind: "text", text: "Page: " },
        { kind: "url", url: "http://127.0.0.1:8372/x/vera.nests/nests?id=1" },
        { kind: "text", text: ". Done" },
    ]);
    expect(splitAddresses("Open http://[::1]:8372/usage?days=7.")).toEqual([
        { kind: "text", text: "Open " },
        { kind: "url", url: "http://[::1]:8372/usage?days=7" },
        { kind: "text", text: "." },
    ]);
    expect(annexLink("http://[::1]:8372/usage?days=7", ANNEX)).toEqual({ page: USAGE, path: "/usage?days=7" });
    expect(splitAddresses("no address here")).toEqual([{ kind: "text", text: "no address here" }]);
});

const workbench: WorkbenchApi = {
    layout: resolveLayout(defaultLayout(), new ContributionRegistry().snapshot()),
    dispatch: () => undefined,
    run: () => undefined,
    hidden: new Set(),
    openMenu: () => undefined,
};

function withLinks(annex: AnnexPagesAnswer | undefined, child: ReturnType<typeof createElement>): string {
    return renderToStaticMarkup(
        createElement(WorkbenchContext.Provider, { value: workbench }, createElement(PageLinksProvider, { annex, children: child })),
    );
}

const noticeCall = (presentation: ToolCall["presentation"]): ToolCall => ({
    tool: "artifact_write",
    title: "artifact_write",
    args: {},
    state: "done",
    output: "ok",
    presentation,
});
const NEST_URL = `${ANNEX.url}x/vera.nests/nests?session=s1&artifact=raid`;
const LINKED = noticeCall({ kind: "tool_notice", text: `Artifact page: ${NEST_URL}`, link: LINK });

test("@core a notice with a link draws as a card under a collapsed run, titled by the link", () => {
    const html = withLinks(ANNEX, createElement(RunLine, { calls: [LINKED] }));
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("call-line");
    expect(html).toContain("class=\"page-card\"");
    expect(html).toContain(`data-page-card="${NOTICE_PATH.replace("&", "&amp;")}"`);
    expect(html).toContain("<span class=\"page-card-title\">Raid</span>");
    expect(html).not.toContain("Artifact page:");
});

test("a card cannot open until the annex is read, and a link to an unlisted page shows the notice's text", () => {
    const early = withLinks(undefined, createElement(RunLine, { calls: [LINKED] }));
    expect(early).toContain("class=\"page-card\"");
    expect(early).not.toContain("data-page-card");
    const unlisted = withLinks(ANNEX, createElement(RunLine, { calls: [noticeCall({ kind: "tool_notice", text: "Elsewhere", link: { title: "Gone", page: "/x/vera.gone/gone" } })] }));
    expect(unlisted).not.toContain("page-card");
    expect(unlisted).toContain("class=\"run-notice\"");
    expect(unlisted).toContain("Elsewhere");
});

test("@core a notice from before links, with a page address in its text, is a card titled by the artifact it names", () => {
    const old = noticeCall({ kind: "tool_notice", text: `Artifact page: ${NEST_URL}` });
    const html = withLinks(ANNEX, createElement(RunLine, { calls: [old] }));
    expect(html).toContain(`data-page-card="${NEST.path}?session=s1&amp;artifact=raid"`);
    expect(html).toContain("<span class=\"page-card-title\">raid</span>");
    const bare = withLinks(ANNEX, createElement(RunLine, { calls: [noticeCall({ kind: "tool_notice", text: `See ${ANNEX.url}x/vera.nests/nests` })] }));
    expect(bare).toContain("<span class=\"page-card-title\">Nests</span>");
    const unread = withLinks(undefined, createElement(RunLine, { calls: [old] }));
    expect(unread).not.toContain("page-card");
    expect(unread).toContain(`Artifact page: ${NEST_URL.replace("&", "&amp;")}`);
});

test("a notice with no address is its text, and the card opens the page on the link's query in its pane", () => {
    const plain = withLinks(ANNEX, createElement(RunLine, { calls: [noticeCall({ kind: "tool_notice", text: "The diff is too large to show." })] }));
    expect(plain).toContain("<p class=\"run-notice\">The diff is too large to show.</p>");

    const view = noticeView(LINKED.presentation as ToolNoticePresentation, ANNEX);
    expect(view).toMatchObject({ kind: "card", title: "Raid", open: { page: NEST, path: NOTICE_PATH } });
    const host = harness();
    if (view.kind === "card" && view.open !== undefined) openAnnexPath(host, view.open.page, view.open.path);
    const [tab] = tabsOf(host, NEST_KIND);
    expect(pageTabs.get(tab!.id)).toBe(NOTICE_PATH);
    expect(host.layout.locations.rightPane.activeTab?.id).toBe(tab!.id);
});

test("a run with no notice draws none", () => {
    const call: ToolCall = { tool: "read", title: "read a", args: { path: "/w/a" }, state: "done", output: "" };
    expect(withLinks(ANNEX, createElement(RunLine, { calls: [call] }))).not.toContain("run-notice");
});

test("@core an annex address in a reply opens the page in the window and other links stay inert", () => {
    const text = "See [the nest](http://127.0.0.1:8372/x/vera.nests/nests?id=2), http://127.0.0.1:8372/usage. Also [site](https://example.com) and https://example.com/a.";
    const html = withLinks(ANNEX, createElement(Markdown, { text }));
    expect(html).toContain("data-page-link=\"/x/vera.nests/nests\">the nest</a>");
    expect(html).toContain("data-page-link=\"/usage\">http://127.0.0.1:8372/usage</a>");
    expect(html).toContain("<a href=\"https://example.com\" title=\"https://example.com\">site</a>");
    expect(html).not.toContain("data-page-link=\"https");
    expect(html).toContain("</a>. Also");
    const before = withLinks(undefined, createElement(Markdown, { text }));
    expect(before).not.toContain("data-page-link");
});

test("@core a notice link names an available app page and carries its query to the page's path", () => {
    expect(noticeTarget(LINK, ANNEX)).toEqual({ page: NEST, path: NOTICE_PATH });
    expect(noticeTarget({ title: "Nests", page: NEST.path }, ANNEX)?.path).toBe(NEST.path);
    expect(noticeTarget({ ...LINK, query: { q: "a b&c" } }, ANNEX)?.path).toBe(`${NEST.path}?q=a+b%26c`);
    expect(noticeTarget({ ...LINK, page: PLAIN.path }, ANNEX)).toBeUndefined();
    expect(noticeTarget({ ...LINK, page: USAGE.path }, ANNEX)).toEqual({ page: USAGE, path: NOTICE_PATH.replace(NEST.path, USAGE.path) });
    expect(noticeTarget({ ...LINK, page: "/x/vera.nests/missing" }, ANNEX)).toBeUndefined();
    expect(noticeTarget(LINK, undefined)).toBeUndefined();
    expect(noticeTarget({ ...LINK, page: USAGE.path }, undefined)).toBeUndefined();
});

test("@core a first link notice adds the page's tab behind the shown tab and marks it changed", () => {
    const host = harness();
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    const files = host.layout.locations.rightPane.activeTab!;
    noticePage(host, noticeTarget(LINK, ANNEX)!);

    const [added] = tabsOf(host, NEST_KIND);
    expect(added).toBeDefined();
    expect(pageTabs.get(added!.id)).toBe(NOTICE_PATH);
    expect(host.layout.locations.rightPane.activeTab?.id).toBe(files.id);
    expect(host.layout.locations.rightPane.visible).toBe(true);
    expect(tabDots.snapshot().has(NEST_KIND)).toBe(true);
});

test("@core a link notice never opens a hidden pane or switches tabs", () => {
    const host = harness();
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    host.dispatch({ type: "toggleLocation", location: "rightPane" });
    expect(host.layout.locations.rightPane.visible).toBe(false);
    noticePage(host, noticeTarget(LINK, ANNEX)!);
    expect(host.layout.locations.rightPane.visible).toBe(false);
    expect(tabsOf(host, NEST_KIND)).toHaveLength(1);
    expect(host.layout.locations.rightPane.activeTab?.container.id).toBe(CORE_CONTAINERS.files);
    expect(tabDots.snapshot().has(NEST_KIND)).toBe(true);

    const empty = harness();
    expect(empty.layout.locations.rightPane.visible).toBe(false);
    tabDots.reset();
    noticePage(empty, noticeTarget(LINK, ANNEX)!);
    expect(empty.layout.locations.rightPane.visible).toBe(false);
    expect(tabsOf(empty, NEST_KIND)).toHaveLength(1);
    expect(tabDots.snapshot().has(NEST_KIND)).toBe(true);
});

test("@core an open pane that shows no tab shows the new page tab, with no change mark", () => {
    const host = harness();
    host.dispatch({ type: "setLocationVisible", location: "rightPane", visible: true });
    expect(host.layout.locations.rightPane.activeTab).toBeUndefined();
    noticePage(host, noticeTarget(LINK, ANNEX)!);
    const [added] = tabsOf(host, NEST_KIND);
    expect(host.layout.locations.rightPane.activeTab?.id).toBe(added!.id);
    expect(tabDots.snapshot().size).toBe(0);
});

test("@core a later link notice adds no second tab, keeps the tab's address and marks it only while it is not shown", () => {
    const host = harness();
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    noticePage(host, noticeTarget(LINK, ANNEX)!);
    const [tab] = tabsOf(host, NEST_KIND);
    tabDots.reset();

    noticePage(host, noticeTarget({ ...LINK, query: { session: "s1", artifact: "loot" } }, ANNEX)!);
    expect(tabsOf(host, NEST_KIND)).toHaveLength(1);
    expect(pageTabs.get(tab!.id)).toBe(NOTICE_PATH);
    expect(tabDots.snapshot().has(NEST_KIND)).toBe(true);

    tabDots.reset();
    host.dispatch({ type: "activateTab", tab: tab!.id });
    noticePage(host, noticeTarget(LINK, ANNEX)!);
    expect(tabDots.snapshot().size).toBe(0);
});

test("two notices before the layout updates ask for one tab", () => {
    const host = harness();
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    const stale: PageHost = { layout: host.layout, dispatch: host.dispatch };
    noticePage(stale, noticeTarget(LINK, ANNEX)!);
    noticePage(stale, noticeTarget({ ...LINK, query: { artifact: "loot" } }, ANNEX)!);
    expect(tabsOf(host, NEST_KIND)).toHaveLength(1);
    expect(pageTabs.get(tabsOf(host, NEST_KIND)[0]!.id)).toBe(NOTICE_PATH);
});

test("a link notice leaves a full pane as it is", () => {
    const host = harness();
    for (let index = 0; index < MAX_TABS; index++) host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    const toasts = currentToasts().length;
    noticePage(host, noticeTarget(LINK, ANNEX)!);
    expect(tabsOf(host, NEST_KIND)).toHaveLength(0);
    expect(tabDots.snapshot().size).toBe(0);
    expect(currentToasts()).toHaveLength(toasts);
});

test("@core a page tab is saved with the layout", () => {
    const host = harness();
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    noticePage(host, noticeTarget(LINK, ANNEX)!);
    const saved = forSave(host.state(), (container) => host.contributions.keepsTabsOut(container));
    expect(saved.tabs.map((tab) => tab.container)).toEqual([CORE_CONTAINERS.files, NEST_KIND]);

    const restored = parseLayout(JSON.parse(JSON.stringify(saved)))!;
    const withKind = new ContributionRegistry();
    registerCoreContributions(withKind);
    registerPaneKind(withKind, pageKinds(ANNEX.pages).find((kind) => kind.id === NEST_KIND)!);
    expect(resolveLayout(restored, withKind.snapshot()).locations.rightPane.tabs.map((tab) => tab.container.id)).toEqual([CORE_CONTAINERS.files, NEST_KIND]);

    // Until the host lists the page again its tab is out of sight, not lost.
    const without = new ContributionRegistry();
    registerCoreContributions(without);
    expect(resolveLayout(restored, without.snapshot()).locations.rightPane.tabs.map((tab) => tab.container.id)).toEqual([CORE_CONTAINERS.files]);
    expect(restored.tabs).toHaveLength(2);
});

test("a tab added in the background leaves the recent order and the active tab alone", () => {
    const host = harness();
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.files });
    const before = host.state();
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.plan, tab: "tab.back", background: true });
    const after = host.state();
    expect(after.tabs.map((tab) => tab.id)).toEqual([...before.tabs.map((tab) => tab.id), "tab.back"]);
    expect(after.recentTabs).toEqual(before.recentTabs);
    expect(after.locations.rightPane.active).toBe(before.locations.rightPane.active);
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.plan, tab: "tab.back", background: true });
    expect(host.state().tabs).toHaveLength(after.tabs.length);
});

test("the change marks are kept per window and clear by kind", () => {
    tabDots.mark(NEST_KIND);
    tabDots.mark("page:/x/vera.other/other");
    expect([...tabDots.snapshot()].sort()).toEqual([NEST_KIND, "page:/x/vera.other/other"]);
    tabDots.clear([NEST_KIND, "page:/x/vera.absent/absent"]);
    expect([...tabDots.snapshot()]).toEqual(["page:/x/vera.other/other"]);
    tabDots.clear([]);
    expect(tabDots.snapshot().size).toBe(1);
});

const NEST_ROUTE: ExtensionRoute = { kind: "extension", path: NEST.path, title: NEST.label };

test("@core the sidebar lists the pages that asked for a pane, and no others", () => {
    expect(extensionPages(ANNEX.pages)).toEqual([NEST]);
    expect(extensionPages([{ label: "Usage", path: "/usage", pane: true }])).toEqual([]);
    expect(extensionPages(Array.from({ length: PAGE_KIND_LIMIT + 4 }, (_, index): AnnexPage => ({
        label: `Page ${index}`,
        path: `/x/vera.many/p${index}`,
        extensionId: "vera.many",
        pane: true,
    })))).toHaveLength(PAGE_KIND_LIMIT);
});

test("a page opened from the sidebar is one route per page, titled with the page's label", () => {
    expect(sameRoute(NEST_ROUTE, { ...NEST_ROUTE })).toBe(true);
    expect(sameRoute(NEST_ROUTE, { kind: "extension", path: "/x/vera.other/other", title: "Other" })).toBe(false);
    expect(sameRoute(NEST_ROUTE, { kind: "work" })).toBe(false);
    expect(routeTitle(NEST_ROUTE)).toBe("Nests");
});

test("@core a page opened from the sidebar draws its frame on the page without a query", () => {
    const html = withLinks(ANNEX, createElement(ExtensionPage, { route: NEST_ROUTE }));
    expect(html).toContain(`src="${ANNEX.url}x/vera.nests/nests"`);
    expect(html).toContain("title=\"Nests\"");
    expect(html).not.toContain("?");
    expect(withLinks(undefined, createElement(ExtensionPage, { route: NEST_ROUTE }))).toContain("Finding Vera");
    expect(withLinks({ ...ANNEX, pages: [USAGE] }, createElement(ExtensionPage, { route: NEST_ROUTE }))).toContain("Not found");
});
