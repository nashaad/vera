import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import { AgentsSection } from "../../clients/ui/src/pages/settings/AgentsSection.tsx";
import { AppearanceSection } from "../../clients/ui/src/pages/settings/AppearanceSection.tsx";
import { ApprovalsSection } from "../../clients/ui/src/pages/settings/ApprovalsSection.tsx";
import { BrowserSection } from "../../clients/ui/src/pages/settings/BrowserSection.tsx";
import { DataSection } from "../../clients/ui/src/pages/settings/DataSection.tsx";
import { ProviderCards } from "../../clients/ui/src/pages/settings/ProviderCards.tsx";
import { ProvidersSection } from "../../clients/ui/src/pages/settings/ProvidersSection.tsx";
import { followStopped, nextRowHighlight, RowHighlightContext } from "../../clients/ui/src/pages/settings/RowHighlight.tsx";
import { nextActiveIndex, searchSettings, SETTINGS_ROWS } from "../../clients/ui/src/pages/settings/rows.ts";
import { SETTINGS_SECTIONS } from "../../clients/ui/src/pages/settings/sections.ts";
import { ShowSection } from "../../clients/ui/src/pages/settings/ShowSection.tsx";
import { SettingRow } from "../../clients/ui/src/pages/settings/SettingRow.tsx";
import { UpdatesSection } from "../../clients/ui/src/pages/settings/UpdatesSection.tsx";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import type { UiState } from "../../clients/ui/src/state/connection.ts";
import { ViewEnvContext, type ViewEnvironment } from "../../clients/ui/src/views/env.tsx";
import { WorkbenchContext, type WorkbenchApi } from "../../clients/ui/src/workbench/context.tsx";

// The sections that hold static settings read these while rendered; a missing window must not throw.
function withDom(render: () => string): string {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { documentElement: { getAttribute: () => null } },
    });
    try {
        return render();
    } finally {
        if (previousWindow === undefined) delete (globalThis as typeof globalThis & { window?: Window }).window;
        else Object.defineProperty(globalThis, "window", previousWindow);
        if (previousDocument === undefined) delete (globalThis as typeof globalThis & { document?: Document }).document;
        else Object.defineProperty(globalThis, "document", previousDocument);
    }
}

const environment = {
    connection: { phase: "detached", sessionRows: [] } as unknown as UiState,
    log: {},
    refreshSessions: () => undefined,
    listAgents: async () => ({ agents: [], warnings: [] }),
} as unknown as ViewEnvironment;

const workbench = { run: () => undefined } as unknown as WorkbenchApi;

function withEnvironment(section: ReturnType<typeof createElement>): string {
    return withDom(() => renderToStaticMarkup(
        createElement(ViewEnvContext.Provider, { value: environment },
            createElement(WorkbenchContext.Provider, { value: workbench }, section)),
    ));
}

function withHighlight(rowId: string | undefined, content: ReactElement): string {
    return withDom(() => renderToStaticMarkup(
        createElement(RowHighlightContext.Provider, { value: { rowId, sheen: 1, sheenReady: true } }, content),
    ));
}

const providerCardsProps = {
    bridge: {} as DesktopBridge,
    providers: [],
    runningProvider: undefined,
    onConnect: () => undefined,
    onCustom: () => undefined,
    onReload: () => undefined,
};

function providerCards(): ReactElement {
    return createElement(ProviderCards, providerCardsProps);
}

function idsIn(html: string): readonly string[] {
    return [...html.matchAll(/data-setting-id="([^"]+)"/g)].map((match) => match[1]!);
}

interface RenderedRowText {
    readonly name: string;
    readonly description: string;
}

function textOf(html: string): string {
    return html
        .replace(/<[^>]*>/g, "")
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}

// React writes one element per row, so the row's markup ends where the next data-setting-id begins.
function renderedRowText(html: string, sectionId: string, rowId: string): RenderedRowText {
    const marker = `data-setting-id="${rowId}"`;
    const start = html.indexOf(marker);
    if (start < 0) throw new Error(`${sectionId} did not render ${rowId}.`);
    const next = html.indexOf('data-setting-id="', start + marker.length);
    const rowHtml = next < 0 ? html.slice(start) : html.slice(start, next);
    const name = /class="(?:setting-name|provider-card-name)"[^>]*>([\s\S]*?)<\/(?:div|span)>/.exec(rowHtml);
    if (name === null) throw new Error(`${rowId} rendered no name.`);
    const description = /class="(?:setting-desc|provider-card-description)"[^>]*>([\s\S]*?)<\/(?:div|span)>/.exec(rowHtml);
    return { name: textOf(name[1]!), description: description === null ? "" : textOf(description[1]!) };
}

describe("settings search matching", () => {
    test("@core finds the one row whose description holds the word", () => {
        const hits = searchSettings("blocks");
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ kind: "row", sectionId: "appearance", rowId: "appearance.code-size", name: "Code size" });
    });

    test("@core finds rows by their section name and the section itself", () => {
        const hits = searchSettings("appearance");
        const rows = hits.flatMap((hit) => hit.kind === "row" ? [hit.rowId] : []);
        expect(rows).toContain("appearance.text-size");
        expect(rows).toContain("data.appearance");
        expect(hits.some((hit) => hit.kind === "section" && hit.sectionId === "appearance")).toBe(true);
    });

    test("@core matches section terms and extra row words, ignoring case", () => {
        const hits = searchSettings("THEME");
        expect(hits.some((hit) => hit.kind === "section" && hit.sectionId === "appearance")).toBe(true);
        expect(searchSettings("shortcut").some((hit) => hit.kind === "section" && hit.sectionId === "keyboard")).toBe(true);
        expect(searchSettings("FINDER").some((hit) => hit.kind === "row" && hit.rowId === "data.desktop-folder")).toBe(true);
    });

    test("@core needs every word in the same row or section, in any order", () => {
        expect(searchSettings("blocks transcript")).toEqual([]);
        expect(searchSettings("transcript past").flatMap((hit) => hit.kind === "row" ? [hit.rowId] : [])).toEqual(["appearance.past-approvals"]);
        expect(searchSettings("blocks size").flatMap((hit) => hit.kind === "row" ? [hit.rowId] : [])).toEqual(["appearance.code-size"]);
    });

    test("a blank query lists nothing and an unknown one lists nothing", () => {
        expect(searchSettings("")).toEqual([]);
        expect(searchSettings("   ")).toEqual([]);
        expect(searchSettings("zzz")).toEqual([]);
    });

    test("row ids are unique and name a real section", () => {
        const sectionIds = new Set(SETTINGS_SECTIONS.map((section) => section.id));
        const rowIds = new Set<string>();
        for (const row of SETTINGS_ROWS) {
            expect(sectionIds.has(row.sectionId)).toBe(true);
            expect(rowIds.has(row.rowId)).toBe(false);
            rowIds.add(row.rowId);
        }
    });
});

describe("settings rows and their rendering", () => {
    const renderers: Readonly<Record<string, () => string>> = {
        appearance: () => withDom(() => renderToStaticMarkup(createElement(AppearanceSection))),
        browser: () => withDom(() => renderToStaticMarkup(createElement(BrowserSection))),
        agents: () => withEnvironment(createElement(AgentsSection)),
        approvals: () => withDom(() => renderToStaticMarkup(createElement(ApprovalsSection))),
        providers: () => withDom(() => `${renderToStaticMarkup(createElement(ProvidersSection))}${renderToStaticMarkup(providerCards())}`),
        updates: () => withDom(() => renderToStaticMarkup(createElement(UpdatesSection))),
        show: () => withDom(() => renderToStaticMarkup(createElement(ShowSection))),
        data: () => withEnvironment(createElement(DataSection)),
    };

    test("@core every listed row is rendered by its section, matches the list text, and every rendered id is listed", () => {
        // Rows whose description is live window state; SETTINGS_ROWS leaves those empty and keeps their words in terms.
        const liveDescriptionRows = new Set(["updates.check-now", "data.desktop-folder"]);
        const listed = new Set(SETTINGS_ROWS.map((row) => row.rowId));
        const rendered = new Set<string>();
        const renderedText = new Map<string, RenderedRowText>();
        for (const row of SETTINGS_ROWS) {
            if (renderers[row.sectionId] === undefined) throw new Error(`no renderer for section ${row.sectionId}`);
        }
        for (const [sectionId, render] of Object.entries(renderers)) {
            const html = render();
            const ids = idsIn(html);
            for (const id of ids) {
                if (!listed.has(id)) throw new Error(`${sectionId} rendered ${id}, which SETTINGS_ROWS does not list.`);
                rendered.add(id);
                renderedText.set(id, renderedRowText(html, sectionId, id));
            }
            for (const row of SETTINGS_ROWS.filter((entry) => entry.sectionId === sectionId)) {
                if (!ids.includes(row.rowId)) throw new Error(`${sectionId} did not render ${row.rowId}.`);
            }
        }
        for (const row of SETTINGS_ROWS) {
            if (!rendered.has(row.rowId)) throw new Error(`${row.rowId} is listed but no section rendered it.`);
            const text = renderedText.get(row.rowId)!;
            if (text.name !== row.name) {
                throw new Error(`${row.rowId} renders the name ${JSON.stringify(text.name)}, but SETTINGS_ROWS says ${JSON.stringify(row.name)}.`);
            }
            if (row.description === "") {
                if (text.description !== "" && !liveDescriptionRows.has(row.rowId)) {
                    throw new Error(`${row.rowId} renders the description ${JSON.stringify(text.description)}, but SETTINGS_ROWS leaves it empty.`);
                }
                continue;
            }
            if (text.description !== row.description) {
                throw new Error(`${row.rowId} renders the description ${JSON.stringify(text.description)}, but SETTINGS_ROWS says ${JSON.stringify(row.description)}.`);
            }
        }
    });
});

describe("settings result selection", () => {
    test("@core arrow keys start at either end and wrap", () => {
        expect(nextActiveIndex(-1, 3, 1)).toBe(0);
        expect(nextActiveIndex(-1, 3, -1)).toBe(2);
        expect(nextActiveIndex(0, 3, -1)).toBe(2);
        expect(nextActiveIndex(2, 3, 1)).toBe(0);
        expect(nextActiveIndex(0, 0, 1)).toBe(-1);
        expect(nextActiveIndex(7, 3, 1)).toBe(0);
    });

    test("@core a highlighted row carries the attribute, and other rows do not", () => {
        const settingRow = (rowId: string | undefined): string => withHighlight(
            rowId,
            createElement(SettingRow, { id: "appearance.text-size", name: "Text size" }),
        );
        expect(settingRow("appearance.text-size")).toContain('data-setting-id="appearance.text-size" data-search-hit="true"');
        expect(settingRow("appearance.text-size")).toContain('data-sheen="b"');
        expect(settingRow("appearance.code-size")).not.toContain("data-search-hit");
        expect(settingRow(undefined)).not.toContain("data-search-hit");

        // Until the layout settles the row carries the outline and shade but no sheen run.
        const pending = withDom(() => renderToStaticMarkup(
            createElement(RowHighlightContext.Provider, { value: { rowId: "appearance.text-size", sheen: 1, sheenReady: false } },
                createElement(SettingRow, { id: "appearance.text-size", name: "Text size" })),
        ));
        expect(pending).toContain('data-search-hit="true"');
        expect(pending).not.toContain("data-sheen");

        const dataSection = (rowId: string | undefined): string => withEnvironment(
            createElement(RowHighlightContext.Provider, { value: { rowId, sheen: 1, sheenReady: true } }, createElement(DataSection)),
        );
        const data = dataSection("data.sessions");
        expect(data).toContain('data-setting-id="data.sessions" data-search-hit="true"');
        expect(data).not.toContain('data-setting-id="data.desktop-folder" data-search-hit="true"');
        expect(dataSection("data.desktop-folder")).not.toContain('data-setting-id="data.sessions" data-search-hit="true"');
        expect(dataSection(undefined)).not.toContain("data-search-hit");

        expect(withHighlight("providers.custom", providerCards())).toContain('data-setting-id="providers.custom" data-search-hit="true"');
        expect(withHighlight("providers.other", providerCards())).not.toContain("data-search-hit");
        expect(withHighlight(undefined, providerCards())).not.toContain("data-search-hit");
    });

    test("@core a row pick sets the row and repeats replay, while a section pick clears it", () => {
        const first = nextRowHighlight({ rowId: undefined, sheen: 0, sheenReady: false }, { kind: "row", rowId: "appearance.code-size" });
        expect(first).toEqual({ rowId: "appearance.code-size", sheen: 1, sheenReady: false });
        const ready = nextRowHighlight(first, { kind: "sheen" });
        expect(ready).toEqual({ rowId: "appearance.code-size", sheen: 1, sheenReady: true });
        const again = nextRowHighlight(ready, { kind: "row", rowId: "appearance.code-size" });
        expect(again).toEqual({ rowId: "appearance.code-size", sheen: 2, sheenReady: false });
        expect(nextRowHighlight(again, { kind: "section" })).toEqual({ rowId: undefined, sheen: 2, sheenReady: false });
    });

    test("@core the follow loop stops after a second still or five seconds from the pick", () => {
        expect(followStopped(0, 0, 999)).toBe(false);
        expect(followStopped(0, 0, 1_000)).toBe(true);
        expect(followStopped(0, 4_000, 4_999)).toBe(false);
        expect(followStopped(0, 4_500, 5_000)).toBe(true);
    });
});
