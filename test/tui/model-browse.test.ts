import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { modelPriceColumns } from "../../clients/tui/model-switch-view.ts";
import { modelDetailFacts } from "../../clients/tui/settings-picker-model.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { TUI_ACCENT, TUI_ELEMENT } from "../../clients/tui/palette.ts";
import { shortlistFactsText, shortlistLegendText } from "../../clients/tui/settings-picker-model.ts";
import { type BrowseDisplayRow, handleModelBrowseKey, modelBrowse, browseHeader, browseFooter, browseModels, browseMatches, browseMoreText, browseWindow, modelBrowseScope, modelBrowseSort, browseSort, browseSections, MODEL_BROWSE_TIPS, modelBrowseTip } from "../../clients/tui/model-browse.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, startTuiProviderPicker, withTuiPickerParent, syncTuiModelPicker, updateTuiSettingsPickerSearch, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";

const rows = [
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", waScore: 1550 },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", pooledRank: 0, unverified: true },
    { value: "q/c", provider: "q", model: "c", label: "Gamma", description: "", pooledRank: 1 },
];
const base: TuiSettingsPickerState = { kind: "model", allOptions: rows, options: rows, selectedIndex: 0, query: "" };

test.each(["standard", "detailed"] as const)("%s restores tips and separates controls from key hints", async (browseView) => {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    view.tip = "Switching keeps the thread; the next turn uses the new model.";
    try {
        view.update({ ...modelBrowse(base, "browse"), browseView }); await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const control = lines.findIndex((line) => line.includes("Manage models"));
        const hint = lines.findIndex((line) => line.includes("Type to search"));
        const tip = lines.findIndex((line) => line.includes("Tip Switching"));
        expect(hint).toBe(control + 2);
        expect(lines[control + 1]!.trim()).toBe("");
        expect(tip).toBe(hint + 3);
        expect(lines[tip - 1]!.trim()).toBe("");
        expect(lines[hint + 1]).toContain("Ctrl+K manage highlighted model");
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(30);
    } finally { setup.renderer.destroy(); }
});

test("Detailed gives a 30-row terminal at least six model rows without duplicate legends", async () => {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        const options = Array.from({ length: 30 }, (_, index) => ({ ...rows[0]!, value: `p/${index}`, model: `${index}`, label: `Entry ${index}`, pricing: { input: 1, output: 2 } }));
        const state = { ...chooseScope(modelBrowse({ ...base, allOptions: options }, "browse")), browseView: "detailed" as const };
        view.update(state); await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame.split("\n").filter((line) => /^\s+Entry \d/.test(line)).length).toBeGreaterThanOrEqual(6);
        expect(frame).toContain("Favorites: not saved");
        expect(frame).not.toContain("Library:");
        expect(frame).not.toContain("* favorite");
        expect(frame).not.toContain("View:");
        expect(frame).not.toContain("input/output per 1M");
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(30);
    } finally { setup.renderer.destroy(); }
});

test.each(["standard", "detailed"] as const)("sparse %s lists shrink and keep summary and headings on the body margin", async (browseView) => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const options = Array.from({ length: 30 }, (_, index) => ({ ...rows[1]!, value: `p/${index}`, model: `${index}`, label: `Item ${index}`, pooledRank: index }));
        view.update({ ...modelBrowse({ ...base, allOptions: options.slice(0, 1) }, "browse"), browseView });
        await setup.renderOnce();
        const sparseHeight = view.box.height;
        const lines = setup.captureCharFrame().split("\n");
        const scope = lines.findIndex((line) => line.includes("Browse models · Favorites"));
        const row = lines.findIndex((line) => line.includes("* Item 0"));
        expect(lines.some((line) => line.includes("View:"))).toBe(false);
        expect(lines.some((line) => line.trim() === "Favorites")).toBe(false);
        expect(lines[scope]!.indexOf("Browse models")).toBe(lines[row]!.indexOf("*"));
        if (browseView === "standard") {
            const price = lines.findIndex((line) => line.includes("Price unavailable"));
            expect(price).toBe(row + 2);
            expect(lines[scope]!.indexOf("Browse models")).toBe(lines[price]!.indexOf("Price"));
        }
        expect(lines.some((line) => line.includes("* favorite"))).toBe(false);
        view.update({ ...modelBrowse({ ...base, allOptions: options }, "browse"), browseView });
        await setup.renderOnce();
        expect(view.box.height).toBeGreaterThan(sparseHeight);
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(44);
        expect(setup.captureCharFrame()).toContain("more models below");
    } finally { setup.renderer.destroy(); }
});

test.each(["standard", "detailed"] as const)("%s picker aligns labels and reserves chevrons for groups", async (browseView) => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const state = { ...modelBrowse(base, "browse"), browseView, modelFocus: "filters" as const };
        view.update(state);
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const labels = ["Filter and sort", "Connect provider", "Manage models"];
        const columns = labels.map((label) => lines.find((line) => line.includes(label))!.indexOf(label));
        expect(new Set(columns).size).toBe(1);
        expect(lines.some((line) => line.includes("View:"))).toBe(false);
        for (const label of labels) {
            const y = lines.findIndex((line) => line.includes(label));
            const control = view.box.getChildren().find((node) => node.screenY === y)!;
            expect(control.width).toBe(view.box.width - 8);
            const backgrounds = setup.captureSpans().lines[y]!.spans.flatMap((span) =>
                Array.from({ length: span.text.length }, () => span.bg.toInts()));
            const expected = RGBA.fromHex(label === "Filter and sort" ? TUI_ACCENT : TUI_ELEMENT).toInts();
            for (const color of backgrounds.slice(control.screenX, control.screenX + control.width)) expect(color).toEqual(expected);
        }
        expect(lines.some((line) => line.includes("Connect provider..."))).toBe(false);
        view.update({ ...state, modelFocus: "search" });
        await setup.renderOnce();
        const blurred = setup.captureCharFrame().split("\n");
        expect(blurred.find((line) => line.includes("Filter and sort"))).toBe(lines.find((line) => line.includes("Filter and sort")));
        const heading = lines.find((line) => line.includes("▼ p"))!;
        const bodyColumn = lines.find((line) => line.includes("Browse models"))!.indexOf("Browse models");
        expect(heading.indexOf("▼")).toBe(bodyColumn);
        expect(lines.find((line) => line.includes("* Beta"))!.indexOf("*")).toBe(bodyColumn);
        expect(heading.indexOf("p")).toBe(bodyColumn + 2);
        const folded = handleTuiSettingsPickerKey({ ...state, modelFocus: "list" }, { name: "space" }).state!;
        view.update(folded);
        await setup.renderOnce();
        const collapsed = setup.captureCharFrame().split("\n").find((line) => line.includes("▶"))!;
        expect(collapsed.indexOf("▶")).toBe(bodyColumn);
    } finally { setup.renderer.destroy(); }
});

test("changing view preserves the query, model, filters and collapsed groups", () => {
    const parent = { ...updateTuiSettingsPickerSearch(modelBrowse(base, "browse"), "alpha").state!, modelFocus: "filters" as const };
    const menu = handleTuiSettingsPickerKey(parent, { name: "enter" }).state!;
    const detailed = handleTuiSettingsPickerKey({ ...menu, selectedIndex: 1 }, { name: "enter" }).state!;
    expect(detailed.parent).toEqual({ ...parent, browseView: "detailed" });
    const again = handleTuiSettingsPickerKey(detailed, { name: "enter" }).state!;
    const standard = handleTuiSettingsPickerKey(again, { name: "escape" }).state!;
    expect(standard).toEqual(parent);
});

test("search crosses favorites but retains explicit filters", () => {
    const allOptions = [
        { ...rows[0]!, images: true, pricing: { input: 0, output: 0 } },
        { ...rows[1]!, unavailable: true }, rows[2]!,
    ];
    const parent = modelBrowse({ ...base, allOptions }, "browse");
    expect(parent.options.map((row) => row.model)).toEqual(["b", "c"]);
    expect(updateTuiSettingsPickerSearch(parent, "alpha").state?.options.map((row) => row.model)).toEqual(["a"]);
    const search = updateTuiSettingsPickerSearch(parent, "alpha").state!;
    expect(updateTuiSettingsPickerSearch(search, "").state?.options.map((row) => row.model)).toEqual(["b", "c"]);
    expect(browseMatches({ ...search, browseProvider: "q" })).toHaveLength(0);
    expect(browseMatches({ ...parent, tab: "all", browseAvailableOnly: true }).map((row) => row.model)).toEqual(["a", "c"]);
    expect(browseMatches({ ...parent, tab: "all", browsePricedOnly: true }).map((row) => row.model)).toEqual(["a"]);
    expect(browseMatches({ ...parent, tab: "all", browseImagesOnly: true }).map((row) => row.model)).toEqual(["a"]);
});

function chooseScope(state: TuiSettingsPickerState, tab: "pool" | "all" = "all"): TuiSettingsPickerState {
    const menu = modelBrowseScope({ ...state, modelFocus: "scope" });
    const result = handleTuiSettingsPickerKey({ ...menu, selectedIndex: tab === "all" ? 1 : 0 }, { name: "enter" });
    return { ...result.state!, modelFocus: "list" };
}

test("Ctrl+G toggles scope from every Switch section without changing cutoff or favorites", () => {
    const options = rows.map((row) => ({ ...row, waScore: 1550 }));
    for (const browseView of ["standard", "detailed"] as const) {
        const start = modelBrowse({ ...base, allOptions: options, browseView, intelligenceCutoff: "1500" }, "browse");
        for (const modelFocus of browseSections(start)) {
            const favorites = { ...start, modelFocus };
            const all = handleTuiSettingsPickerKey(favorites, { name: "g", ctrl: true });
            expect(all.handled).toBe(true);
            expect(all.state?.tab).toBe("all");
            expect(all.state?.options.map((row) => row.model)).toEqual(["a", "b", "c"]);
            expect(all.state?.options[all.state.selectedIndex]?.value).toBe(favorites.options[favorites.selectedIndex]?.value);
            expect(all.poolToggle).toBeUndefined();
            expect(all.state?.modelFocus).toBe(modelFocus);
            expect(all.state?.intelligenceCutoff).toBe("1500");
            expect(all.state?.browseView).toBe(browseView);
            const back = handleTuiSettingsPickerKey(all.state!, { name: "g", ctrl: true }).state!;
            expect(back).toEqual(favorites);
        }
    }
});

test("Ctrl+G retains query, explicit filters and search across connected models", () => {
    const start = { ...updateTuiSettingsPickerSearch(modelBrowse(base, "browse"), "alpha").state!, browseProvider: "p", browseAvailableOnly: true };
    const all = handleTuiSettingsPickerKey(start, { name: "g", ctrl: true }).state!;
    const favorites = handleTuiSettingsPickerKey(all, { name: "g", ctrl: true }).state!;
    expect(favorites.query).toBe("alpha");
    expect(favorites.queryCursor).toBe(start.queryCursor);
    expect(favorites.browseProvider).toBe("p");
    expect(favorites.browseAvailableOnly).toBe(true);
    expect(favorites.options.map((row) => row.model)).toEqual(["a"]);
    expect(updateTuiSettingsPickerSearch(favorites, "").state?.options.map((row) => row.model)).toEqual(["b"]);
});

test("Ctrl+G handles empty favorites and a selected model outside favorites", () => {
    const start = modelBrowse({ ...base, allOptions: [rows[0]!] }, "browse");
    expect(start.options).toHaveLength(0);
    const all = handleTuiSettingsPickerKey(start, { name: "g", ctrl: true }).state!;
    expect(all.options).toHaveLength(1);
    const back = handleTuiSettingsPickerKey(all, { name: "g", ctrl: true, shift: true }).state!;
    expect(back.tab).toBe("pool");
    expect(back.options).toHaveLength(0);
    expect(back.selectedIndex).toBe(0);
});


test("scope counts ignore query and cutoff", () => {
    const state = { ...modelBrowse(base, "browse"), query: "missing", intelligenceCutoff: "1600" as const };
    expect(modelBrowseScope(state).options.map((row) => row.label)).toEqual(["Favorites (2)", "All connected (3)"]);
});


test("Enter favorites in either scope and never switches the model", () => {
    let state = modelBrowse(base, "browse");
    expect(state.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["b", "c"]);
    expect(browseHeader(state)).not.toContain("Cutoff");
    expect(handleModelBrowseKey(state, { name: "enter" }).selection).toBeUndefined();
    expect(handleModelBrowseKey(state, { name: "enter" }).poolToggle).toEqual({ action: "remove", provider: "p", model: "b" });
    state = chooseScope(state);
    expect(browseMatches(state)).toHaveLength(3);
    expect(handleModelBrowseKey(state, { name: "enter" }).selection).toBeUndefined();
    expect(handleModelBrowseKey(state, { name: "r", ctrl: true }).refreshAllCatalogs).toBe(true);
});

test("library Enter only keeps or unkeeps and row verbs are chords", () => {
    const state = { ...modelBrowse(base, "favorites"), selectedIndex: 1 };
    expect(state.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["a", "b", "c"]);
    expect(handleModelBrowseKey(state, { name: "enter" }).poolToggle).toEqual({ action: "remove", provider: "p", model: "b" });
    expect(handleModelBrowseKey(state, { name: "enter" }).selection).toBeUndefined();
    expect(handleModelBrowseKey(state, { name: "r", ctrl: true }).poolName?.model).toBe("b");
    expect(handleModelBrowseKey(state, { name: "y", ctrl: true }).poolVerify?.model).toBe("b");
    expect(handleModelBrowseKey(state, { name: "r" }).handled).toBe(false);
    expect(browseHeader(state)).toBe("");
});

test("cutoff excludes unscored models only in all scope; search selects one model", () => {
    let state = { ...modelBrowse(base, "browse"), tab: "all" as const, intelligenceCutoff: "1500" as const };
    expect(browseModels(state).filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["a"]);
    expect(browseHeader(state)).toContain("2 hidden below the cutoff, including 2 unscored");
    const manage = updateTuiSettingsPickerSearch(modelBrowse(base, "favorites"), "beta").state!;
    expect(handleModelBrowseKey(manage, { name: "enter" }).poolToggle?.model).toBe("b");
});

test("verification does not require a favorite", () => {
    const state = modelBrowse(base, "favorites");
    const refused = handleModelBrowseKey(state, { name: "y", ctrl: true });
    expect(refused.poolVerify?.model).toBe("a");
    expect(refused.state?.browseFeedback).toBeUndefined();
    expect(handleModelBrowseKey({ ...state, selectedIndex: 1 }, { name: "y", ctrl: true }).poolVerify?.model).toBe("b");
});

test("live library search accepts spaces and row actions do not appear as another screen", async () => {
    const setup = await createTestRenderer({ width: 110, height: 32 });
    const view = createTuiSettingsPickerView(setup.renderer);
    try {
        let state = modelBrowse(base, "favorites");
        view.update(state);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        for (const name of ["b", "space", "p"]) {
            state = view.handleEditorKey(state, { name, sequence: name === "space" ? " " : name }).state ?? state;
            view.update(state);
        }
        expect(state.query).toBe("b p");
        expect(state.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["b"]);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Favorites");
        // A kept row carries the star, and the legend below the list says what it means.
        expect(frame).toContain("★ -");
        expect(frame).toContain("★ kept");
        expect(frame).not.toContain("Actions");
    } finally { setup.renderer.destroy(); }
});

test("default assignment offers connected models and discloses verification", async () => {
    const { startTuiModelAssignmentPicker } = await import("../../clients/tui/settings-picker.ts");
    const pane = startTuiModelAssignmentPicker("eco", "eco", "", [
        { provider: "p", model: "a", label: "A", available: true, verified: false, levels: [] },
        { provider: "p", model: "b", label: "B", available: true, verified: true, levels: [] },
    ]);
    expect(pane.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["a", "b"]);
    expect(pane.subtitle).toContain("cost");
    expect(pane.options.some((row) => row.label === "Favorites")).toBe(true);
});

test("a kept current model that disappears stays removable but cannot be selected", async () => {
    const { startTuiSettingsPicker } = await import("../../clients/tui/settings-picker.ts");
    const picker = startTuiSettingsPicker("model", "gone", undefined, "ask", [], "default", "p", undefined, [
        { provider: "p", model: "gone", label: "Gone", available: false, verified: true, levels: [] },
    ]);
    const switched = modelBrowse({ ...picker, providerCatalogs: [{ id: "p", label: "P", refreshedAt: "2026-09-06" }] }, "browse");
    expect(switched.options[switched.selectedIndex]?.unavailable).toBe(true);
    expect(handleModelBrowseKey(switched, { name: "enter" }).selection).toBeUndefined();
    const managed = modelBrowse(switched, "favorites");
    expect(browseHeader(managed)).toBe("");
    expect(handleModelBrowseKey(managed, { name: "enter" }).poolToggle?.action).toBe("remove");
});

test("model browse cards contain the footer and padding for empty, short, and full lists", async () => {
    const setup = await createTestRenderer({ width: 110, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        for (const count of [0, 1, 30]) {
            const options = Array.from({ length: count }, (_, index) => ({
                ...rows[1]!, value: `p/model-${index}`, model: `model-${index}`, pooledRank: index,
            }));
            for (const mode of ["browse", "favorites"] as const) {
                for (const browseNotice of [undefined, "Catalog refreshed."]) {
                    view.update({ ...modelBrowse({ ...base, options, allOptions: options }, mode), browseNotice });
                    await setup.renderOnce();
                    const bottom = view.box.screenY + view.box.height;
                    expect(bottom).toBeLessThanOrEqual(setup.renderer.height - 1);
                    for (const child of view.box.getChildren()) {
                        expect(child.screenY + child.height).toBeLessThanOrEqual(bottom - 1);
                    }
                    const frame = setup.captureCharFrame().split("\n");
                    const footer = frame.findIndex((line) => line.includes(mode === "browse" ? "Tab sections" : "⏎ / Ctrl+S"));
                    expect(footer).toBeGreaterThan(view.box.screenY);
                    expect(footer).toBeLessThan(bottom - 1);
                }
            }
        }
    } finally { setup.renderer.destroy(); }
});

test("providers opened from either model surface never expose the legacy tabs", async () => {
    const setup = await createTestRenderer({ width: 110, height: 32 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        for (const mode of ["browse", "favorites"] as const) {
            const parent = modelBrowse(base, mode);
            const providers = withTuiPickerParent(startTuiProviderPicker([], {
                subtitle: "No provider connected. Add provider to discover models.",
            }), parent);
            view.update(providers);
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Configure providers");
            expect(frame).toContain("Add provider");
            expect(frame).not.toContain("Providers ^e");
            expect(frame).not.toContain("⇥ tabs");
            for (const shift of [false, true]) {
                expect(handleTuiSettingsPickerKey(providers, { name: "tab", shift }).state).toBe(providers);
            }
            expect(handleTuiSettingsPickerKey(providers, { name: "escape" }).state).toBe(parent);
        }
    } finally { setup.renderer.destroy(); }
});

test("plain provider groups keep a stable order and open headings stay out of navigation", () => {
    const state = modelBrowse(base, "favorites");
    expect(state.options.map((row) => row.group)).toEqual(["p", "p", "q"]);
    expect(state.options.every((row) => row.model !== undefined && row.section === undefined)).toBe(true);
    expect(handleModelBrowseKey(state, { name: "right" }).state?.modelFocus).toBe("search");
    const next = handleModelBrowseKey(state, { name: "down" }).state!;
    expect(next.options[next.selectedIndex]?.model).toBe("b");
    const searched = updateTuiSettingsPickerSearch(state, "beta").state!;
    expect(searched.options[searched.selectedIndex]?.model).toBe("b");
    expect(handleModelBrowseKey(searched, { name: "enter" }).poolToggle?.model).toBe("b");
});

test("a folded group collapses to one heading row that counts what it hides", () => {
    const state = modelBrowse(base, "favorites");
    const group = state.options[0]?.group;
    const folded = handleModelBrowseKey({ ...state, selectedIndex: 0 }, { name: "space", sequence: " " }).state!;
    const heading = folded.options[folded.selectedIndex]!;
    expect(heading.section).toBe(group);
    expect(heading.label).toBe(`${group} (2)`);
    expect(heading.sectionCollapsed).toBe(true);
    expect(folded.options.filter((row) => row.group === group)).toHaveLength(1);
    // Enter opens it again, so a fold is never a dead end.
    const opened = handleModelBrowseKey(folded, { name: "enter" }).state!;
    expect(opened.options.filter((row) => row.group === group)).toHaveLength(2);
});

test("reduced catalogs hide old entries without hiding kept models or search results", () => {
    const options = [rows[0]!, { ...rows[1]!, hiddenByDefault: "old" as const },
        { ...rows[2]!, pooledRank: undefined, hiddenByDefault: "superseded" as const }];
    let state = chooseScope(modelBrowse({ ...base, allOptions: options }, "browse"));
    expect(browseMatches(state).map((row) => row.model)).toEqual(["a", "b"]);
    expect(handleModelBrowseKey(state, { name: "k", ctrl: true }).state?.options.find((row) => row.value === "variants")?.label).toBe("Show extra variants and older models");
    state = handleModelBrowseKey(state, { name: "a", ctrl: true }).state!;
    expect(browseMatches(state)).toHaveLength(3);
    expect(handleModelBrowseKey(state, { name: "k", ctrl: true }).state?.options.find((row) => row.value === "variants")?.label).toBe("Hide extra variants and older models");
    state = handleModelBrowseKey(state, { name: "a", ctrl: true }).state!;
    const search = updateTuiSettingsPickerSearch(state, "gamma").state!;
    expect(search.options[search.selectedIndex]?.model).toBe("c");
    const managed = modelBrowse({ ...base, allOptions: options }, "favorites");
    expect(handleModelBrowseKey(managed, { name: "enter" }).poolToggle?.model).toBe("a");
});

test("large provider sections stay open and bounded windows retain provider context", () => {
    const options = Array.from({ length: 60 }, (_, index) => ({
        ...rows[0]!, value: JSON.stringify(["p", `model-${index}`]), model: `model-${index}`, label: `Model ${index}`,
    }));
    let state = chooseScope(modelBrowse({ ...base, allOptions: options }, "browse"));
    expect(state.options).toHaveLength(60);
    state = { ...state, selectedIndex: 40 };
    const window = browseWindow(state, 12).rows;
    expect(window.length).toBeLessThanOrEqual(12);
    expect(window[0]?.heading).toBe("p");
    expect(window.some((row) => row.index === state.selectedIndex)).toBe(true);
    const refreshed = syncTuiModelPicker(state, { provider: "p", model: "model-0",
        availableModels: options.map((row) => ({ provider: row.provider, model: row.model, label: row.label, description: "", levels: [] })) });
    expect(refreshed.collapsed ?? []).toEqual(state.collapsed ?? []);
    expect(refreshed.options[refreshed.selectedIndex]?.value).toBe(state.options[state.selectedIndex]?.value);
});

test("stepping through an overflowing window moves the list by one line, or two next to a group heading", () => {
    const options = Array.from({ length: 30 }, (_, index) => ({
        ...rows[0]!, provider: `p${Math.floor(index / 4)}`, value: `p/${index}`, model: `${index}`, label: `Model ${index}`,
    }));
    const state = chooseScope(modelBrowse({ ...base, allOptions: options }, "browse"));
    const walk = [...state.options.keys(), ...[...state.options.keys()].reverse()];
    let top = 0;
    let previous = 0;
    let lines: readonly BrowseDisplayRow[] | undefined;
    for (const selectedIndex of walk) {
        const window = browseWindow({ ...state, selectedIndex }, 12, top);
        expect(window.rows).toHaveLength(12);
        expect(window.rows.some((row) => row.index === selectedIndex)).toBe(true);
        expect(window.rows[0]?.heading !== undefined && window.rows[1]?.heading !== undefined).toBe(false);
        const last = (index: number) => state.options[index + 1]?.group !== state.options[index]?.group;
        const nearHeading = last(selectedIndex) || last(previous);
        expect(Math.abs(window.top - top)).toBeLessThanOrEqual(nearHeading ? 2 : 1);
        previous = selectedIndex;
        if (lines !== undefined && window.top === top) {
            expect(window.rows.slice(0, 10).map((row) => row.option?.value ?? row.heading))
                .toEqual(lines.slice(0, 10).map((row) => row.option?.value ?? row.heading));
        }
        top = window.top;
        lines = window.rows;
    }
});

test("walking down to a group boundary and back up keeps the list still, matching the contract example", () => {
    const options = [
        ...Array.from({ length: 20 }, (_, index) => `mock-model-${String(index + 1).padStart(2, "0")}`)
            .map((label) => ({ ...rows[0]!, provider: "mock", value: `mock/${label}`, model: label, label })),
        ...["AionLabs: Aion-3.0", "AionLabs: Aion-3.0-Mini", ...Array.from({ length: 128 }, (_, index) => `Zeta ${String(index).padStart(3, "0")}`)]
            .map((label) => ({ ...rows[0]!, provider: "openrouter", value: `openrouter/${label}`, model: label, label })),
    ];
    const state = chooseScope(modelBrowse({ ...base, allOptions: options }, "browse"));
    const at = (label: string) => state.options.findIndex((row) => row.label === label);
    const frame = (rows: readonly BrowseDisplayRow[]) => rows.map((row) =>
        row.more !== undefined ? browseMoreText(row.more) : row.heading !== undefined ? `▼ ${row.heading}` : row.option?.label ?? "");
    let top = 0;
    for (let selectedIndex = 0; selectedIndex <= at("AionLabs: Aion-3.0-Mini"); selectedIndex++) {
        top = browseWindow({ ...state, selectedIndex }, 15, top).top;
    }
    const expected = [
        `▼ ${state.options[0]!.group}`,
        ...Array.from({ length: 9 }, (_, index) => `mock-model-${index + 12}`),
        `▼ ${state.options[at("AionLabs: Aion-3.0")]!.group}`,
        "AionLabs: Aion-3.0",
        "AionLabs: Aion-3.0-Mini",
        "",
        "↑ 11 more models above · ↓ 128 more models below",
    ];
    for (const label of ["AionLabs: Aion-3.0-Mini", "AionLabs: Aion-3.0", "mock-model-20", "mock-model-13"]) {
        const window = browseWindow({ ...state, selectedIndex: at(label) }, 15, top);
        expect(window.top).toBe(top);
        expect(frame(window.rows)).toEqual(expected);
    }
});

test("an overflowing window ends with counts of the models above and below it", () => {
    const options = Array.from({ length: 60 }, (_, index) => ({
        ...rows[0]!, value: `p/${index}`, model: `${index}`, label: `Model ${index}`,
    }));
    const state = chooseScope(modelBrowse({ ...base, allOptions: options }, "browse"));
    for (const [selectedIndex, above, below] of [[0, false, true], [30, true, true], [59, true, false]] as const) {
        const window = browseWindow({ ...state, selectedIndex }, 12).rows;
        expect(window.length).toBe(12);
        const more = window.at(-1)?.more;
        expect(more).toBeDefined();
        expect(window.at(-2)).toEqual({ index: -1 });
        expect(window.filter((row) => row.option !== undefined).length + more!.above + more!.below).toBe(60);
        expect([more!.above > 0, more!.below > 0]).toEqual([above, below]);
    }
    const short = chooseScope(modelBrowse(base, "browse"));
    expect(browseWindow(short, 12).rows.some((row) => row.more !== undefined)).toBe(false);
    expect(browseWindow(short, 12).rows.filter((row) => row.option !== undefined)).toHaveLength(3);
    expect(browseMoreText({ above: 2, below: 1 })).toBe("↑ 2 more models above · ↓ 1 more model below");
    expect(browseMoreText({ above: 0, below: 122 }, 30)).toBe("↓ 122 more models below");
    expect(browseMoreText({ above: 2, below: 1 }, 20)).toBe("↑ 2 · ↓ 1");
});

test("narrow Switch cards draw nothing outside the card and keep one gap above search", async () => {
    const allOptions = Array.from({ length: 128 }, (_, index) => ({
        ...rows[0]!, value: `p/${index}`, model: `${index}`, label: `DeepSeek V4 Flash ${index}`,
        pricing: { input: 0.22, output: 0.66 }, images: true, ...(index < 5 ? { pooledRank: index } : {}),
    }));
    for (const height of [24, 40]) {
        const setup = await createTestRenderer({ width: 58, height });
        const view = createTuiSettingsPickerView(setup.renderer);
        setup.renderer.root.add(view.surface); view.surface.visible = true;
        try {
            const library = modelBrowse({ ...base, allOptions }, "browse");
            for (const state of [library, chooseScope(library)]) {
                let geometry: number[] | undefined;
                for (const intelligenceCutoff of ["any", "1600"] as const) {
                    view.update({ ...state, intelligenceCutoff, selectedIndex: 2 }); await setup.renderOnce();
                    const lines = setup.captureCharFrame().split("\n");
                    const { screenX, screenY, width } = view.box;
                    for (const line of lines) {
                        expect(line.slice(0, screenX).trim()).toBe("");
                        expect(line.slice(screenX + width).trim()).toBe("");
                    }
                    const frame = lines.join("\n");
                    expect(frame).toContain("Tab sections");
                    expect(frame).toContain("Manage models");
                    const current = [screenY, view.box.height];
                    if (geometry) {
                        expect(Math.abs(current[0]! - geometry[0]!)).toBeLessThanOrEqual(1);
                        expect(current[1]! - geometry[1]!).toBe(1);
                    } else geometry = current;
                    expect(screenY + view.box.height).toBeLessThanOrEqual(height);
                    expect(lines.find((line) => line.includes("Browse models"))).toContain("esc");
                    expect(lines.findIndex((line) => line.includes("Search models"))).toBeLessThan(lines.findIndex((line) => line.includes("Filter and sort")));

                }
            }
        } finally { setup.renderer.destroy(); }
    }
});

test("provider headings sit directly under the previous group inside the card", async () => {
    const setup = await createTestRenderer({ width: 110, height: 32 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        view.update(modelBrowse(base, "favorites"));
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        // An open group carries the ▼ that says Space folds it.
        const heading = lines.findIndex((line) => line.split("│")[0]?.trim() === "▼ q");
        expect(heading).toBeGreaterThan(0);
        expect(lines[heading - 1]?.split("│")[0]).toContain("Beta");
        expect(lines[heading + 1]).toContain("Gamma");
        expect(view.box.screenY + view.box.height).toBeLessThan(setup.renderer.height);
    } finally { setup.renderer.destroy(); }
});

test("cutoff is reached through the vertical filter menu", () => {
    const state = { ...chooseScope(modelBrowse(base, "browse")), modelFocus: "filters" as const };
    const menu = handleTuiSettingsPickerKey(state, { name: "enter" }).state!;
    expect(menu.title).toBe("Filter and sort");
    const cutoff = handleTuiSettingsPickerKey({ ...menu, selectedIndex: menu.options.findIndex((row) => row.value === "cutoff") }, { name: "enter" }).state!;
    expect(cutoff.title).toBe("Filter and sort");
    const adjusted = handleTuiSettingsPickerKey(cutoff, { name: "right" }).state!;
    expect(adjusted.parent?.intelligenceCutoff).toBe("1400");
    const result = handleTuiSettingsPickerKey(adjusted, { name: "escape" }).state!;
    expect(result.intelligenceCutoff).toBe("1400");
    expect(result.options.map((row) => row.model)).toEqual(["a"]);
    expect(result.collapsed).toEqual([]);
});


test("highlighted model details follow the row and distinguish verified, failed, and unknown facts", async () => {
    const setup = await createTestRenderer({ width: 140, height: 40 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const options = [{ ...rows[0]!, unverified: false, images: true },
            { ...rows[1]!, verificationError: "probe refused" }];
        let state = modelBrowse({ ...base, allOptions: options }, "favorites");
        state = { ...state, selectedIndex: state.options.findIndex((row) => row.model === "a") };
        view.update(state);
        await setup.renderOnce();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("answered a live probe");
        expect(frame).toContain("Images");
        expect(frame).toContain("Model ID");
        expect(frame).toContain("WA Score");
        expect(frame.split("\n").some((line) => line.includes("│") && line.includes("Alpha"))).toBe(true);
        state = { ...state, selectedIndex: state.options.findIndex((row) => row.model === "b") };
        view.update(state);
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("failed: probe refused");
        expect(frame).toContain("not known");
        expect(frame).not.toContain("answered a live probe");
        expect(frame).not.toContain("→ actions");
        expect(frame).not.toContain("Unpin");
    } finally { setup.renderer.destroy(); }
});

test("Detailed separates long names from compact prices and retains exact detail rates", async () => {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        const option = { ...rows[0]!, label: "DeepSeek V4 Flash 0423 with a long name", pricing: { input: 0.088606, output: 0.177212 } };
        const state = { ...chooseScope(modelBrowse({ ...base, allOptions: [option] }, "browse")), browseView: "detailed" as const };
        view.update(state); await setup.renderOnce();
        const row = setup.captureCharFrame().split("\n").find((line) => line.includes("$0.09"))!;
        expect(row).toMatch(/DeepSeek.*…\s+1550\s+\$0\.09\s+\$0\.18/);
        expect(modelDetailFacts(state, option)).toContainEqual(["Full price", "0.088606/0.177212"]);
        expect(modelPriceColumns({ ...option, pricing: { input: 0.00000001234, output: 0 } })).toContain("$1.2e-8");
        expect(modelPriceColumns({ ...option, pricing: undefined })).toMatch(/\?\s+\?/);
    } finally { setup.renderer.destroy(); }
});

test.each([90, 100, 120, 170])("Detailed aligns WA scores and prices at %s columns", async (width) => {
    const setup = await createTestRenderer({ width, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        const options = [
            { ...rows[0]!, label: "Preferred", pricing: { input: 0.07, output: 0.13 } },
            { ...rows[1]!, label: "Steady", waScore: 980, pricing: { input: 2, output: 6 }, unavailable: true },
            { ...rows[2]!, label: "Unknown" },
        ];
        const state = { ...chooseScope(modelBrowse({ ...base, allOptions: options }, "browse")), browseView: "detailed" as const, initialModel: "p/a" };
        view.update(state); await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const preferred = lines.find((line) => line.includes("$0.07") && line.includes("Preferred"))!;
        const steady = lines.find((line) => line.includes("$2") && line.includes("Steady"))!;
        expect(preferred).toContain("current");
        expect(steady).toContain("unavailable");
        const header = lines.find((line) => line.includes("Input") && line.includes("Output"))!;
        const scoreEnd = header.indexOf("WA Score") + "WA Score".length;
        expect(header).toContain("WA Score");
        expect(preferred.indexOf("1550") + 4).toBe(scoreEnd);
        expect(steady.indexOf("980") + 3).toBe(scoreEnd);
        const unknown = lines.find((line) => line.includes("Unknown"))!;
        expect(unknown.slice(scoreEnd - 8, scoreEnd).trim()).toBe("?");
        expect(preferred.indexOf("$0.07") + 5).toBe(steady.indexOf("$2") + 2);
        expect(preferred.indexOf("$0.13") + 5).toBe(steady.indexOf("$6") + 2);
        expect(lines.some((line) => line.includes("Input") && line.includes("Output"))).toBe(true);
        view.update({ ...state, browseView: "standard" }); await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("Input    Output");
        expect(setup.captureCharFrame()).not.toContain("View:");
        setup.resize(58, 24);
        view.update(state); await setup.renderOnce();
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(23);
        expect(setup.captureCharFrame()).toContain("Manage models");
    } finally { setup.renderer.destroy(); }
});


test("All keeps its price band and footer inside a short terminal with cutoff and refresh notice", async () => {
    const setup = await createTestRenderer({ width: 110, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const state = chooseScope(modelBrowse(base, "browse"));
        view.update({ ...state, intelligenceCutoff: "1400", browseNotice: "Catalog refreshed." });
        await setup.renderOnce();
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(23);
        expect(setup.captureCharFrame()).toContain("⏎ unfavorite");
    } finally { setup.renderer.destroy(); }
});


test("browse panels stay vertically centred as scope, content, and terminal size change", async () => {
    const setup = await createTestRenderer({ width: 140, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const shortlist = modelBrowse(base, "browse");
        for (const state of [shortlist, chooseScope(shortlist), modelBrowse(base, "favorites")]) {
            view.update(state);
            await setup.renderOnce();
            const above = view.box.screenY;
            const below = setup.renderer.height - above - view.box.height;
            expect(above).toBeGreaterThan(1);
            expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
        }
        setup.resize(100, 24);
        view.update(shortlist);
        await setup.renderOnce();
        expect(view.box.screenY).toBeGreaterThanOrEqual(1);
        expect(Math.abs(2 * view.box.screenY + view.box.height - 24)).toBeLessThanOrEqual(1);
        view.surface.visible = false;
        await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("Browse models");
    } finally { setup.renderer.destroy(); }
});


test("Ctrl+D/U page without changing membership and Ctrl+S retains the row toggle", () => {
    const options = Array.from({ length: 30 }, (_, index) => ({ ...rows[0]!, value: `p/${index}`, model: `${index}`, pooledRank: index }));
    for (const mode of ["browse", "favorites"] as const) {
        const start = { ...modelBrowse({ ...base, allOptions: options }, mode), modelFocus: "list" as const };
        const down = handleTuiSettingsPickerKey(start, { name: "d", ctrl: true }, 8);
        expect(down.state?.selectedIndex).toBe(start.selectedIndex + 4);
        expect(down.poolBulk).toBeUndefined();
        expect(down.poolToggle).toBeUndefined();
        const up = handleTuiSettingsPickerKey(down.state!, { name: "u", ctrl: true }, 8);
        expect(up.state?.selectedIndex).toBe(start.selectedIndex);
        expect(up.poolBulk).toBeUndefined();
        expect(up.poolToggle).toBeUndefined();
        const atTop = handleTuiSettingsPickerKey({ ...start, selectedIndex: 0 }, { name: "u", ctrl: true }, 8);
        expect(atTop.state?.selectedIndex).toBe(0);
        expect(handleTuiSettingsPickerKey(start, { name: "s", ctrl: true }).poolToggle).toEqual({
            action: "remove", provider: start.options[start.selectedIndex]!.provider!, model: start.options[start.selectedIndex]!.model!,
        });
        if (mode === "favorites") {
            expect(handleTuiSettingsPickerKey(start, { name: "k", ctrl: true, shift: true }).poolBulk).toBeUndefined();
        } else {
            expect(handleTuiSettingsPickerKey(start, { name: "s", ctrl: true, shift: true }).state?.modelBrowse).toBe("browse");
            // The provider catalog takes the same key, so a model found there
            // can be kept without leaving the list.
            let all = chooseScope(start);
            all = handleTuiSettingsPickerKey(all, { name: "down" }).state!;
            const row = all.options[all.selectedIndex]!;
            expect(handleTuiSettingsPickerKey(all, { name: "s", ctrl: true }).poolToggle).toEqual({
                action: row.pooledRank === undefined ? "add" : "remove", provider: row.provider!, model: row.model!,
            });
        }
    }
});


test("scope is prominent and highlighting across provider boundaries never moves the card or footer", async () => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const options = Array.from({ length: 28 }, (_, index) => ({ ...rows[0]!, value: `p/${index}`, model: `${index}`,
            provider: index < 15 ? "p" : "q", label: `Model ${index}`, pooledRank: index < 3 ? index : undefined,
            ...(index % 2 ? { pricing: { input: 1, output: 3 }, images: true, recommended: true } : {}) }));
        for (const mode of ["browse", "favorites"] as const) {
            const state = mode === "browse" ? chooseScope(modelBrowse({ ...base, allOptions: options }, mode))
                : modelBrowse({ ...base, allOptions: options }, mode);
            let geometry: number[] | undefined;
            for (let selectedIndex = 0; selectedIndex < state.options.length; selectedIndex++) {
                view.update({ ...state, selectedIndex });
                await setup.renderOnce();
                const frame = setup.captureCharFrame();
                const footerY = frame.split("\n").findIndex((line) => line.includes("^d/^u page"));
                const current = [view.box.screenY, view.box.height, footerY];
                if (geometry) expect(current).toEqual(geometry); else geometry = current;
                expect(frame).not.toContain("fold provider");
                // Nothing is folded here, so no group shows the folded marker.
                expect(frame).not.toContain("▶");
                if (mode === "browse") {
                    expect(frame).toContain("All connected models");
                    expect(frame).not.toContain("[ Catalog ]");
                    expect(frame).not.toContain("[ Library ]");
                    expect(frame).toContain("All connected models");
                }
            }
        }
    } finally { setup.renderer.destroy(); }
});


test("Switch sizes each scope consistently and Tab preserves the model", async () => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        for (const height of [44, 24]) {
            setup.resize(110, height);
            let state = modelBrowse(base, "browse");
            const geometry = new Map<string, number[]>();
            for (let i = 0; i < 4; i++) {
                view.update(state); await setup.renderOnce();
                const footer = setup.captureCharFrame().split("\n").findIndex((line) => line.includes("^d/^u page"));
                const next = [view.box.screenY, view.box.height, footer];
                const key = state.tab ?? "pool";
                if (geometry.has(key)) expect(next).toEqual(geometry.get(key)!); else geometry.set(key, next);
                expect(view.box.screenY).toBeGreaterThanOrEqual(0);
                expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(height);
                state = chooseScope(state, state.tab === "all" ? "pool" : "all");
            }
        }
        let all = chooseScope(modelBrowse(base, "browse"));
        all = updateTuiSettingsPickerSearch(all, "alpha").state!;
        const model = all.options[all.selectedIndex]?.model;
        view.update(all);
        expect(view.handleEditorKey(all, { name: "left" }).handled).toBe(true);
        all = handleTuiSettingsPickerKey(all, { name: "tab" }).state!;
        expect(all.modelFocus).toBe("list");
        expect(all.intelligenceCutoff ?? "any").toBe("any");
        all = handleTuiSettingsPickerKey(all, { name: "tab" }).state!;
        expect(all.modelFocus).toBe("filters");
        expect(all.options[all.selectedIndex]?.model).toBe(model);
        expect(all.query).toBe("alpha");
    } finally { setup.renderer.destroy(); }
});

test("Tab cycles interactive sections without changing scope or model; reverse Tab reverses it", () => {
    for (const tab of ["pool", "all"] as const) {
        let state = { ...chooseScope(modelBrowse(base, "browse"), tab), selectedIndex: 1 };
        const selected = state.options[state.selectedIndex]?.value;
        const sections = browseSections(state);
        for (let i = 0; i < sections.length; i++) {
            const before = state;
            state = handleTuiSettingsPickerKey(state, { name: "tab" }).state!;
            expect(state.tab).toBe(tab);
            expect(state.options[state.selectedIndex]?.value).toBe(selected);
            for (const key of [{ name: "tab", shift: true }, { name: "backtab" }]) {
                expect(handleTuiSettingsPickerKey(state, key).state).toEqual(before);
            }
        }
        expect(state.modelFocus).toBe("list");
        expect(sections).not.toContain("detail");
        // Space folds the group and leaves the cursor on the heading it just
        // folded; Space again opens it.
        const folded = handleTuiSettingsPickerKey(state, { name: "space", sequence: " " }).state!;
        const group = state.options[state.selectedIndex]?.group;
        expect(folded.collapsed).toContain(group);
        expect(folded.options[folded.selectedIndex]?.section).toBe(group);
        const opened = handleTuiSettingsPickerKey(folded, { name: "space", sequence: " " }).state!;
        expect(opened.collapsed).not.toContain(group);
        expect(opened.options[opened.selectedIndex]?.group).toBe(group);
        expect(opened.options[opened.selectedIndex]?.section).toBeUndefined();
    }
});


test("Switch names the half-page keys only while the list has the keys", () => {
    const state = { ...modelBrowse(base, "browse"), modelFocus: "list" as const };
    expect(browseFooter(state).split("\n")[1]).toBe("↑↓ ^d^u choose · ⏎ / ^s remove from favorites · Space fold/unfold");
    for (const focus of ["scope", "sort", "search", "more"] as const) {
        expect(browseFooter({ ...state, modelFocus: focus })).not.toContain("^d^u");
    }
    for (const [name, index] of [["d", state.options.length - 1], ["u", 0]] as const) {
        expect(handleModelBrowseKey(state, { name, ctrl: true }).state?.selectedIndex).toBe(index);
    }
});

test("Manage offers one model action and explains catalog visibility on its own line", () => {
    const state = modelBrowse(base, "favorites");
    expect(browseFooter(state).split("\n")).toEqual([
        "⏎ / Ctrl+S  Add to favorites",
        "Ctrl+A  Show extra variants and older models",
        "↑↓ choose · Space fold/unfold · Tab sections",
        "Ctrl+R Rename · Ctrl+Y Verify · Esc Back",
    ]);
    expect(browseFooter({ ...state, modelFocus: "search" }).split("\n")[2]).toBe("Type to search · ↑↓ sections · Tab sections");
    expect(browseFooter({ ...state, selectedIndex: 1 })).toContain("Remove from favorites");
    expect(browseFooter({ ...state, revealAll: true }).split("\n")[1]).toBe("Ctrl+A  Hide extra variants and older models");
    for (const query of ["", "beta"]) for (const shift of [false, true]) {
        const filtered = updateTuiSettingsPickerSearch(state, query).state!;
        const ignored = handleTuiSettingsPickerKey(filtered, { name: "k", ctrl: true, shift });
        expect(ignored.poolBulk).toBeUndefined();
        expect(ignored.poolToggle).toBeUndefined();
        expect(ignored.state).toBe(filtered);
    }
});

test("filtered results size the card consistently without losing controls", async () => {
    const options = Array.from({ length: 40 }, (_, index) => ({
        ...rows[0]!, value: `p/${index}`, model: `${index}`, label: `Model ${index}`,
        waScore: index > 35 ? 1550 : undefined,
        pricing: index > 35 ? { input: 1, output: 3 } : undefined,
        pooledRank: index === 0 ? 0 : undefined,
    }));
    for (const [width, height] of [[110, 44], [70, 30]]) {
        const setup = await createTestRenderer({ width, height });
        const view = createTuiSettingsPickerView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            let state = chooseScope(modelBrowse({ ...base, allOptions: options }, "browse"));
            state = handleTuiSettingsPickerKey(state, { name: "tab", shift: true }).state!;
            const expected = new Map<number, number[]>();
            for (let step = 0; step < 7; step++) {
                view.update(state); await setup.renderOnce();
                const frame = setup.captureCharFrame();
                const lines = frame.split("\n");
                const anchors = ["Search models", "Filter and sort", "Manage models", "Tab sections"].map((text) => lines.findIndex((line) => line.includes(text)));
                expect(anchors.every((y) => y >= 0)).toBe(true);
                const geometry = [view.box.screenY, view.box.height, ...anchors];
                const count = state.options.length;
                if (expected.has(count)) expect(geometry).toEqual(expected.get(count)!); else expected.set(count, geometry);
                expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(height!);
                expect(frame).not.toContain("fewer models");
                expect(browseHeader(state)).not.toContain("^a");
                expect(anchors[2]).toBeGreaterThan(anchors[1]!);
                state = handleTuiSettingsPickerKey(state, { name: "g", ctrl: true }).state!;
            }
        } finally { setup.renderer.destroy(); }
    }
});


test("typing and paste from every Switch control focuses search at its preserved caret", async () => {
    const setup = await createTestRenderer({ width: 110, height: 38 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        for (const modelFocus of ["scope", "sort", "search", "intelligence", "list", "more"] as const) {
            const state = { ...chooseScope(modelBrowse(base, "browse")), modelFocus, query: "bta", queryCursor: 1 };
            view.update(state);
            const typed = view.handleEditorKey(state, { name: "e", sequence: "e" }).state!;
            expect(typed.query).toBe("beta");
            expect(typed.queryCursor).toBe(2);
            expect(typed.modelFocus).toBe("search");
            expect(typed.options.map((row) => row.label)).toEqual(["Beta"]);
            view.update(state);
            const pasted = view.handleEditorPaste(state, "e").state!;
            expect(pasted.query).toBe("beta");
            expect(pasted.modelFocus).toBe("search");
        }
    } finally { setup.renderer.destroy(); }
});


test("confirming scope focuses models while cancelling restores Show", () => {
    const parent = { ...chooseScope(modelBrowse(base, "browse")), modelFocus: "scope" as const };
    const menu = modelBrowseScope(parent);
    expect(handleTuiSettingsPickerKey(menu, { name: "escape" }).state).toBe(parent);
    for (const selectedIndex of [0, 1]) {
        const selected = handleTuiSettingsPickerKey({ ...menu, selectedIndex }, { name: "enter" }).state!;
        expect(selected.modelFocus).toBe("list");
        expect(selected.tab).toBe(selectedIndex === 0 ? "pool" : "all");
        expect(selected.query).toBe(parent.query);
        expect(selected.intelligenceCutoff).toBe(parent.intelligenceCutoff);
    }
});


test("the browse tip cycles and every line fits one row", () => {
    for (const tip of MODEL_BROWSE_TIPS) expect(tip.length).toBeLessThanOrEqual(64);
    const seen = MODEL_BROWSE_TIPS.map((_, turn) => modelBrowseTip(turn));
    expect(seen).toEqual([...MODEL_BROWSE_TIPS]);
    expect(modelBrowseTip(MODEL_BROWSE_TIPS.length)).toBe(MODEL_BROWSE_TIPS[0]);
    expect(modelBrowseTip(-1)).toBe(MODEL_BROWSE_TIPS[MODEL_BROWSE_TIPS.length - 1]);
});

const priced = [
    { value: "p/z", provider: "p", model: "z", label: "Zeta", description: "", pooledRank: 0, pricing: { input: 1, output: 2 } },
    { value: "p/m", provider: "p", model: "m", label: "Mu", description: "", pooledRank: 1 },
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", pooledRank: 2, pricing: { input: 3, output: 15 } },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", pooledRank: 3, pricing: { input: 0.5, output: 12 } },
    { value: "q/c", provider: "q", model: "c", label: "Gamma", description: "", pooledRank: 4, pricing: { input: 0.1, output: 0.1 } },
];

function chooseSort(state: TuiSettingsPickerState, label: string): TuiSettingsPickerState {
    const menu = modelBrowseSort({ ...state, modelFocus: "sort" });
    return handleTuiSettingsPickerKey({ ...menu, selectedIndex: menu.options.findIndex((row) => row.label === label) }, { name: "enter" }).state!;
}

test("sort orders models inside each provider group, unpriced last", () => {
    const state = modelBrowse({ ...base, allOptions: priced }, "browse");
    const labels = (next: TuiSettingsPickerState) => next.options.map((row) => row.label);
    expect(browseSort(state)).toBe("library");
    expect(labels(state)).toEqual(["Zeta", "Mu", "Alpha", "Beta", "Gamma"]);
    expect(labels(chooseSort(state, "A to Z"))).toEqual(["Alpha", "Beta", "Mu", "Zeta", "Gamma"]);
    // 3:1 input:output puts Zeta (1.25) ahead of Beta (3.38) and Alpha (6); Gamma stays under its own heading.
    expect(labels(chooseSort(state, "Cheapest first"))).toEqual(["Zeta", "Beta", "Alpha", "Mu", "Gamma"]);
});

test("Library order is offered only in Library models and Catalog falls back to A to Z", () => {
    const state = modelBrowse({ ...base, allOptions: priced }, "browse");
    expect(modelBrowseSort(state).options.map((row) => row.label)).toEqual(["Favorite order", "A to Z", "Cheapest first"]);
    const catalog = chooseScope(state);
    expect(browseSort(catalog)).toBe("az");
    expect(modelBrowseSort(catalog).options.map((row) => row.label)).toEqual(["A to Z", "Cheapest first"]);
    const cheap = chooseScope(chooseSort(state, "Cheapest first"));
    expect(browseSort(cheap)).toBe("price");
});

test("confirming a sort keeps the highlighted model while cancelling restores Sort", () => {
    const state = { ...modelBrowse({ ...base, allOptions: priced }, "browse"), selectedIndex: 2 };
    const sorted = chooseSort(state, "A to Z");
    expect(sorted.modelFocus).toBe("list");
    expect(sorted.options[sorted.selectedIndex]?.label).toBe("Alpha");
    const menu = handleTuiSettingsPickerKey({ ...state, modelFocus: "sort" }, { name: "enter" }).state!;
    expect(menu.title).toBe("Sort models");
    const back = handleTuiSettingsPickerKey(menu, { name: "escape" }).state!;
    expect(back.modelFocus).toBe("sort");
    expect(back.options.map((row) => row.label)).toEqual(state.options.map((row) => row.label));
});

test("footer actions are mouse-accessible across the full inner width", async () => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    const opened: string[] = [];
    view.onBrowseAction = (section) => opened.push(section);
    try {
        view.update(modelBrowse(base, "browse")); await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        for (const label of ["Filter and sort", "Connect provider", "Manage models"]) {
            const y = lines.findIndex((line) => line.includes(label));
            expect(y).toBeGreaterThan(0);
            await setup.mockMouse.click(view.box.screenX + view.box.width - 5, y);
        }
        expect(opened).toEqual(["filters", "providers", "more"]);
        expect(lines.findIndex((line) => line.includes("Search models"))).toBeLessThan(lines.findIndex((line) => line.includes("Filter and sort")));
    } finally { setup.renderer.destroy(); }
});


test("a host snapshot keeps the chosen sort", () => {
    const sorted = chooseSort(modelBrowse({ ...base, allOptions: priced }, "browse"), "Cheapest first");
    expect(syncTuiModelPicker(sorted, undefined).browseSort).toBe("price");
});

test("unowned arrows follow the vertical section order", () => {
    const state = modelBrowse(base, "browse");
    expect(state.modelFocus).toBe("search");
    const press = (focus: TuiSettingsPickerState["modelFocus"], name: string) => handleTuiSettingsPickerKey({ ...state, modelFocus: focus }, { name }).state!;
    expect(press("search", "right").modelFocus).toBe("search");
    expect(press("search", "down").modelFocus).toBe("list");
    expect(press("list", "down").modelFocus).toBe("list");
    expect(press("list", "right").modelFocus).toBe("filters");
    expect(press("filters", "right").modelFocus).toBe("providers");
    expect(press("providers", "right").modelFocus).toBe("more");
    expect(press("more", "right").modelFocus).toBe("search");
});


test("a free model reads free and an unlisted price reads no price", () => {
    expect(shortlistFactsText({ ...rows[0]!, pricing: { input: 0, output: 0 } })).toContain("free");
    expect(shortlistFactsText({ ...rows[0]!, pricing: { input: 3, output: 6 } })).toContain("$3/6");
    expect(shortlistFactsText(rows[0]!)).toContain("no price");
    expect(shortlistFactsText(rows[0]!)).not.toContain("?");
    for (const width of [200, 70, 40]) {
        expect(shortlistLegendText(width)).not.toContain("price");
        expect(shortlistLegendText(width)).not.toContain("?");
    }
});

test("Favorites has Search and Models sections under the same arrow rule", async () => {
    const press = (state: TuiSettingsPickerState, name: string, shift = false) =>
        handleTuiSettingsPickerKey(state, { name, shift, ...(name === "space" ? { sequence: " " } : {}) });
    const library = modelBrowse(base, "favorites");
    const search = { ...library, modelFocus: "search" as const };
    expect(library.modelFocus).toBe("list");
    // Two sections: every unowned arrow and Tab lands on the other one.
    for (const name of ["left", "right"]) expect(press(library, name).state?.modelFocus).toBe("search");
    for (const name of ["up", "down"]) expect(press(search, name).state?.modelFocus).toBe("list");
    expect(press(library, "tab").state?.modelFocus).toBe("search");
    expect(press(search, "tab", true).state?.modelFocus).toBe("list");
    // Models keep up/down at the edges, and Space folds instead of left/right.
    expect(press({ ...library, selectedIndex: 0 }, "up").state?.modelFocus).toBe("list");
    const folded = press({ ...library, selectedIndex: 0 }, "space").state!;
    expect(folded.options[folded.selectedIndex]?.sectionCollapsed).toBe(true);
    expect(press(search, "left").state?.modelFocus).toBe("search");
    // Enter in Search acts on the highlighted model.
    expect(press(search, "enter").poolToggle?.model).toBe("a");
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        view.update(library);
        const typed = view.handleEditorKey(library, { name: "b", sequence: "b" }).state!;
        expect(typed.modelFocus).toBe("search");
        expect(typed.query).toBe("b");
        expect(view.handleEditorKey(library, { name: "space", sequence: " " }).handled).toBe(false);
        view.update(typed);
        expect(view.handleEditorKey(typed, { name: "space", sequence: " " }).state?.query).toBe("b ");
    } finally { setup.renderer.destroy(); }
});

test("Space types only in Search; elsewhere it stays out of the query", async () => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        const state = { ...modelBrowse(base, "browse"), query: "a", queryCursor: 1 };
        for (const modelFocus of ["scope", "sort", "intelligence", "list", "more"] as const) {
            const focused = { ...state, modelFocus };
            view.update(focused);
            expect(view.handleEditorKey(focused, { name: "space", sequence: " " }).handled).toBe(false);
        }
        const searching = { ...state, modelFocus: "search" as const };
        view.update(searching);
        expect(view.handleEditorKey(searching, { name: "space", sequence: " " }).state?.query).toBe("a ");
    } finally { setup.renderer.destroy(); }
});


test.each([24, 36])("filter dialog explains the score beside its slider at %s rows", async (height) => {
    const setup = await createTestRenderer({ width: 80, height });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    const state = modelBrowse(base, "browse");
    const menu = handleTuiSettingsPickerKey({ ...state, modelFocus: "filters" }, { name: "enter" }).state!;
    try {
        view.update({ ...menu, selectedIndex: menu.options.findIndex((row) => row.value === "cutoff") });
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("WA Score: WebDev Arena (LMArena)");
        expect(frame).toContain("Elo rating");
        expect(frame).toContain("Higher is better");
        expect(frame).toContain("unscored models");
        expect(frame).toContain("esc back");
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(height);
    } finally { setup.renderer.destroy(); }
});
