import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { TUI_ACCENT, TUI_ELEMENT } from "../../clients/tui/palette.ts";
import { type JourneyDisplayRow, handleModelJourneyKey, modelJourney, journeyHeader, journeyFooter, journeyModels, journeyMatches, journeyMoreText, journeyWindow, modelJourneyScope, modelJourneySort, journeySort, journeySections, MODEL_SWITCH_TIPS, modelSwitchTip } from "../../clients/tui/model-journeys.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, startTuiProviderPicker, withTuiPickerParent, syncTuiModelPicker, updateTuiSettingsPickerSearch, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";

const rows = [
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", waScore: 1550 },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", pooledRank: 0, unverified: true },
    { value: "q/c", provider: "q", model: "c", label: "Gamma", description: "", pooledRank: 1 },
];
const base: TuiSettingsPickerState = { kind: "model", allOptions: rows, options: rows, selectedIndex: 0, query: "" };

function chooseScope(state: TuiSettingsPickerState, tab: "pool" | "all" = "all"): TuiSettingsPickerState {
    const menu = modelJourneyScope({ ...state, modelFocus: "scope" });
    const result = handleTuiSettingsPickerKey({ ...menu, selectedIndex: tab === "all" ? 1 : 0 }, { name: "enter" });
    return { ...result.state!, modelFocus: "list" };
}


test("scope selector counts ignore search and cutoff and keep their geometry", async () => {
    const allOptions = Array.from({ length: 100 }, (_, index) => ({
        ...rows[0]!, value: `p/${index}`, model: `${index}`,
        ...(index < 9 ? { pooledRank: index } : {}),
        ...(index >= 90 ? { hiddenByDefault: "old" as const } : {}),
    }));
    for (const width of [110, 50, 40]) {
        const setup = await createTestRenderer({ width, height: 44 });
        const view = createTuiSettingsPickerView(setup.renderer);
        setup.renderer.root.add(view.surface); view.surface.visible = true;
        let opened = 0;
        view.onScope = () => { opened++; };
        let expected: number[] | undefined;
        try {
            for (const revealAll of [false, true]) for (const tab of ["pool", "all"] as const) {
                const state = chooseScope({ ...modelJourney({ ...base, allOptions }, "switch"), revealAll,
                    query: "missing", intelligenceCutoff: "1600" }, tab);
                view.update(state); await setup.renderOnce();
                const filter = view.box.getChildren().find((node) => node.id === "model-filter")!;
                const scope = filter.getChildren().find((node) => node.id === "model-scope")!;
                expect(scope).toBeDefined();
                expect(setup.captureCharFrame()).toContain(tab === "pool" ? "Library models (9)" : `Provider catalog (${revealAll ? 100 : 90})`);
                const geometry = [scope.screenX, scope.screenY, scope.width, scope.height];
                if (expected) expect(geometry).toEqual(expected); else expected = geometry;
                const scopeLine = setup.captureCharFrame().split("\n")[scope.screenY]!;
                expect(setup.captureCharFrame()).toContain("Filter Models:");
                expect(scopeLine.slice(scope.screenX)).toStartWith(" › ");
                expect(scopeLine).not.toContain("Show ");
                expect(scopeLine).not.toContain("[");
                expect(scopeLine).not.toContain("]");
                expect(scope.screenY - filter.screenY).toBe(width === 110 ? 0 : 1);
                const scopeSpan = () => setup.captureSpans().lines[geometry[1]!]!.spans
                    .find((span) => span.text.includes(tab === "pool" ? "Library models" : "Provider catalog"))!;
                expect(scopeSpan().bg.toInts()).toEqual(RGBA.fromHex(TUI_ELEMENT).toInts());
                const beforeClick = opened;
                await setup.mockMouse.click(filter.screenX, filter.screenY);
                expect(opened).toBe(beforeClick);
                await setup.mockMouse.click(scope.screenX + 1, scope.screenY);
                expect(opened).toBe(beforeClick + 1);
                view.update({ ...state, modelFocus: "scope" }); await setup.renderOnce();
                const focused = view.box.getChildren().find((node) => node.id === "model-filter")!
                    .getChildren().find((node) => node.id === "model-scope")!;
                expect([focused.screenX, focused.screenY, focused.width, focused.height]).toEqual(geometry);
                expect(setup.captureCharFrame().split("\n")[focused.screenY]).toBe(scopeLine);
                expect(scopeSpan().bg.toInts()).toEqual(RGBA.fromHex(TUI_ACCENT).toInts());
                const menu = modelJourneyScope(state);
                expect(menu.options.map((row) => row.label)).toEqual(["Library models (9)", `Provider catalog (${revealAll ? 100 : 90})`]);
            }
        } finally { setup.renderer.destroy(); }
    }
});

test("Enter switches in either scope without toggling membership", () => {
    let state = modelJourney(base, "switch");
    expect(state.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["b", "c"]);
    expect(journeyHeader(state)).not.toContain("Cutoff");
    expect(handleModelJourneyKey(state, { name: "enter" }).selection).toEqual({ kind: "model", provider: "p", model: "b" });
    state = chooseScope(state);
    expect(journeyMatches(state)).toHaveLength(3);
    expect(handleModelJourneyKey(state, { name: "enter" }).poolToggle).toBeUndefined();
    expect(handleModelJourneyKey(state, { name: "r", ctrl: true }).refreshAllCatalogs).toBe(true);
});

test("library Enter only keeps or unkeeps and row verbs are chords", () => {
    const state = { ...modelJourney(base, "shortlist"), selectedIndex: 1 };
    expect(state.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["a", "b", "c"]);
    expect(handleModelJourneyKey(state, { name: "enter" }).poolToggle).toEqual({ action: "remove", provider: "p", model: "b" });
    expect(handleModelJourneyKey(state, { name: "enter" }).selection).toBeUndefined();
    expect(handleModelJourneyKey(state, { name: "r", ctrl: true }).poolName?.model).toBe("b");
    expect(handleModelJourneyKey(state, { name: "y", ctrl: true }).poolVerify?.model).toBe("b");
    expect(handleModelJourneyKey(state, { name: "r" }).handled).toBe(false);
    expect(journeyHeader(state)).toBe("");
});

test("cutoff excludes unscored models only in all scope; search selects one model", () => {
    let state = { ...modelJourney(base, "switch"), tab: "all" as const, intelligenceCutoff: "1500" as const };
    expect(journeyModels(state).filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["a"]);
    expect(journeyHeader(state)).toContain("2 hidden below the cutoff, including 2 unscored");
    const manage = updateTuiSettingsPickerSearch(modelJourney(base, "shortlist"), "beta").state!;
    expect(handleModelJourneyKey(manage, { name: "enter" }).poolToggle?.model).toBe("b");
});

test("verification refuses models that have not been in your library", () => {
    const state = modelJourney(base, "shortlist");
    const refused = handleModelJourneyKey(state, { name: "y", ctrl: true });
    expect(refused.poolVerify).toBeUndefined();
    expect(refused.state?.journeyFeedback?.message).toBe("Add Alpha to your library before verifying it.");
    expect(handleModelJourneyKey({ ...state, selectedIndex: 1 }, { name: "y", ctrl: true }).poolVerify?.model).toBe("b");
});

test("live library search accepts spaces and row actions do not appear as another screen", async () => {
    const setup = await createTestRenderer({ width: 110, height: 32 });
    const view = createTuiSettingsPickerView(setup.renderer);
    try {
        let state = modelJourney(base, "shortlist");
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
        expect(frame).toContain("Model Library");
        // A kept row carries the star, and the legend below the list says what it means.
        expect(frame).toContain("★ ?");
        expect(frame).toContain("★ kept");
        expect(frame).not.toContain("Actions");
    } finally { setup.renderer.destroy(); }
});

test("default assignment offers only verified library models and both recovery routes", async () => {
    const { startTuiModelAssignmentPicker } = await import("../../clients/tui/settings-picker.ts");
    const pane = startTuiModelAssignmentPicker("eco", "eco", "", [
        { provider: "p", model: "a", label: "A", available: true, verified: false, levels: [] },
        { provider: "p", model: "b", label: "B", available: true, verified: true, levels: [] },
    ]);
    expect(pane.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["b"]);
    expect(pane.options.some((row) => row.label === "Verify library models")).toBe(true);
    expect(pane.options.some((row) => row.label === "Model Library")).toBe(true);
});

test("a kept current model that disappears stays removable but cannot be selected", async () => {
    const { startTuiSettingsPicker } = await import("../../clients/tui/settings-picker.ts");
    const picker = startTuiSettingsPicker("model", "gone", undefined, "ask", [], "default", "p", undefined, [
        { provider: "p", model: "gone", label: "Gone", available: false, verified: true, levels: [] },
    ]);
    const switched = modelJourney({ ...picker, providerCatalogs: [{ id: "p", label: "P", refreshedAt: "2026-09-06" }] }, "switch");
    expect(switched.options[switched.selectedIndex]?.unavailable).toBe(true);
    expect(handleModelJourneyKey(switched, { name: "enter" }).selection).toBeUndefined();
    const managed = modelJourney(switched, "shortlist");
    expect(journeyHeader(managed)).toBe("");
    expect(handleModelJourneyKey(managed, { name: "enter" }).poolToggle?.action).toBe("remove");
});

test("model journey cards contain the footer and padding for empty, short, and full lists", async () => {
    const setup = await createTestRenderer({ width: 110, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        for (const count of [0, 1, 30]) {
            const options = Array.from({ length: count }, (_, index) => ({
                ...rows[1]!, value: `p/model-${index}`, model: `model-${index}`, pooledRank: index,
            }));
            for (const journey of ["switch", "shortlist"] as const) {
                for (const journeyNotice of [undefined, "Catalog refreshed."]) {
                    view.update({ ...modelJourney({ ...base, options, allOptions: options }, journey), journeyNotice });
                    await setup.renderOnce();
                    const bottom = view.box.screenY + view.box.height;
                    expect(bottom).toBeLessThanOrEqual(setup.renderer.height - 1);
                    for (const child of view.box.getChildren()) {
                        expect(child.screenY + child.height).toBeLessThanOrEqual(bottom - 1);
                    }
                    const frame = setup.captureCharFrame().split("\n");
                    const footer = frame.findIndex((line) => line.includes(journey === "switch" ? "switch model" : "⏎ / Ctrl+S"));
                    expect(footer).toBeGreaterThan(view.box.screenY);
                    expect(footer).toBeLessThan(bottom - 1);
                }
            }
        }
    } finally { setup.renderer.destroy(); }
});

test("providers opened from either model journey never expose the legacy tabs", async () => {
    const setup = await createTestRenderer({ width: 110, height: 32 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        for (const journey of ["switch", "shortlist"] as const) {
            const parent = modelJourney(base, journey);
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
    const state = modelJourney(base, "shortlist");
    expect(state.options.map((row) => row.group)).toEqual(["p", "p", "q"]);
    expect(state.options.every((row) => row.model !== undefined && row.section === undefined)).toBe(true);
    expect(handleModelJourneyKey(state, { name: "right" }).state?.modelFocus).toBe("search");
    const next = handleModelJourneyKey(state, { name: "down" }).state!;
    expect(next.options[next.selectedIndex]?.model).toBe("b");
    const searched = updateTuiSettingsPickerSearch(state, "beta").state!;
    expect(searched.options[searched.selectedIndex]?.model).toBe("b");
    expect(handleModelJourneyKey(searched, { name: "enter" }).poolToggle?.model).toBe("b");
});

test("a folded group collapses to one heading row that counts what it hides", () => {
    const state = modelJourney(base, "shortlist");
    const group = state.options[0]?.group;
    const folded = handleModelJourneyKey({ ...state, selectedIndex: 0 }, { name: "space", sequence: " " }).state!;
    const heading = folded.options[folded.selectedIndex]!;
    expect(heading.section).toBe(group);
    expect(heading.label).toBe(`${group} (2)`);
    expect(heading.sectionCollapsed).toBe(true);
    expect(folded.options.filter((row) => row.group === group)).toHaveLength(1);
    // Enter opens it again, so a fold is never a dead end.
    const opened = handleModelJourneyKey(folded, { name: "enter" }).state!;
    expect(opened.options.filter((row) => row.group === group)).toHaveLength(2);
});

test("reduced catalogs hide old entries without hiding kept models or search results", () => {
    const options = [rows[0]!, { ...rows[1]!, hiddenByDefault: "old" as const },
        { ...rows[2]!, pooledRank: undefined, hiddenByDefault: "superseded" as const }];
    let state = chooseScope(modelJourney({ ...base, allOptions: options }, "switch"));
    expect(journeyMatches(state).map((row) => row.model)).toEqual(["a", "b"]);
    expect(handleModelJourneyKey(state, { name: "k", ctrl: true }).state?.options.find((row) => row.value === "variants")?.label).toBe("Show extra variants and older models");
    state = handleModelJourneyKey(state, { name: "a", ctrl: true }).state!;
    expect(journeyMatches(state)).toHaveLength(3);
    expect(handleModelJourneyKey(state, { name: "k", ctrl: true }).state?.options.find((row) => row.value === "variants")?.label).toBe("Hide extra variants and older models");
    state = handleModelJourneyKey(state, { name: "a", ctrl: true }).state!;
    const search = updateTuiSettingsPickerSearch(state, "gamma").state!;
    expect(search.options[search.selectedIndex]?.model).toBe("c");
    const managed = modelJourney({ ...base, allOptions: options }, "shortlist");
    expect(handleModelJourneyKey(managed, { name: "enter" }).poolToggle?.model).toBe("a");
});

test("large provider sections stay open and bounded windows retain provider context", () => {
    const options = Array.from({ length: 60 }, (_, index) => ({
        ...rows[0]!, value: JSON.stringify(["p", `model-${index}`]), model: `model-${index}`, label: `Model ${index}`,
    }));
    let state = chooseScope(modelJourney({ ...base, allOptions: options }, "switch"));
    expect(state.options).toHaveLength(60);
    state = { ...state, selectedIndex: 40 };
    const window = journeyWindow(state, 12).rows;
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
    const state = chooseScope(modelJourney({ ...base, allOptions: options }, "switch"));
    const walk = [...state.options.keys(), ...[...state.options.keys()].reverse()];
    let top = 0;
    let previous = 0;
    let lines: readonly JourneyDisplayRow[] | undefined;
    for (const selectedIndex of walk) {
        const window = journeyWindow({ ...state, selectedIndex }, 12, top);
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
    const state = chooseScope(modelJourney({ ...base, allOptions: options }, "switch"));
    const at = (label: string) => state.options.findIndex((row) => row.label === label);
    const frame = (rows: readonly JourneyDisplayRow[]) => rows.map((row) =>
        row.more !== undefined ? journeyMoreText(row.more) : row.heading !== undefined ? `▼ ${row.heading}` : row.option?.label ?? "");
    let top = 0;
    for (let selectedIndex = 0; selectedIndex <= at("AionLabs: Aion-3.0-Mini"); selectedIndex++) {
        top = journeyWindow({ ...state, selectedIndex }, 15, top).top;
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
        const window = journeyWindow({ ...state, selectedIndex: at(label) }, 15, top);
        expect(window.top).toBe(top);
        expect(frame(window.rows)).toEqual(expected);
    }
});

test("an overflowing window ends with counts of the models above and below it", () => {
    const options = Array.from({ length: 60 }, (_, index) => ({
        ...rows[0]!, value: `p/${index}`, model: `${index}`, label: `Model ${index}`,
    }));
    const state = chooseScope(modelJourney({ ...base, allOptions: options }, "switch"));
    for (const [selectedIndex, above, below] of [[0, false, true], [30, true, true], [59, true, false]] as const) {
        const window = journeyWindow({ ...state, selectedIndex }, 12).rows;
        expect(window.length).toBe(12);
        const more = window.at(-1)?.more;
        expect(more).toBeDefined();
        expect(window.at(-2)).toEqual({ index: -1 });
        expect(window.filter((row) => row.option !== undefined).length + more!.above + more!.below).toBe(60);
        expect([more!.above > 0, more!.below > 0]).toEqual([above, below]);
    }
    const short = chooseScope(modelJourney(base, "switch"));
    expect(journeyWindow(short, 12).rows.some((row) => row.more !== undefined)).toBe(false);
    expect(journeyWindow(short, 12).rows.filter((row) => row.option !== undefined)).toHaveLength(3);
    expect(journeyMoreText({ above: 2, below: 1 })).toBe("↑ 2 more models above · ↓ 1 more model below");
    expect(journeyMoreText({ above: 0, below: 122 }, 30)).toBe("↓ 122 more models below");
    expect(journeyMoreText({ above: 2, below: 1 }, 20)).toBe("↑ 2 · ↓ 1");
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
            const library = modelJourney({ ...base, allOptions }, "switch");
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
                    expect(frame).toContain("Tab / Shift+Tab sections · Esc back");
                    expect(frame).toContain("› Ctrl+K More");
                    const current = [screenY, view.box.height];
                    if (geometry) expect(current).toEqual(geometry); else geometry = current;
                    if (state.tab === "all") {
                        const filter = lines.findIndex((line) => line.includes("A to Z ▾"));
                        const header = lines.findIndex((line) => line.includes("Models from your connected providers"));
                        const search = lines.findIndex((line) => line.includes("Search models"));
                        expect(header - filter).toBe(1);
                        expect(search - header).toBe(3);
                        if (height === 40) expect(frame).toContain("more models below");
                    } else {
                        expect(lines.filter((line) => line.includes("DeepSeek V4 Flash")).length).toBe(5);
                    }
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
        view.update(modelJourney(base, "shortlist"));
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

test("the intelligence slider is visible in All and arrows adjust it without folding providers", async () => {
    const setup = await createTestRenderer({ width: 110, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        let state = chooseScope(modelJourney(base, "switch"));
        state = { ...state, selectedIndex: 0 };
        state = handleModelJourneyKey(state, { name: "tab", shift: true }).state!;
        expect(state.modelFocus).toBe("intelligence");
        view.update(state);
        await setup.renderOnce();
        const before = setup.captureCharFrame();
        expect(before).toContain("Smarter");
        expect(before).toContain("▲");
        expect(view.handleEditorKey(state, { name: "right" }).handled).toBe(false);
        state = handleModelJourneyKey(state, { name: "right" }).state!;
        expect(state.intelligenceCutoff).toBe("1400");
        expect(journeyMatches(state).map((row) => row.model)).toEqual(["a"]);
        view.update(state);
        await setup.renderOnce();
        const after = setup.captureCharFrame();
        const marker = (frame: string) => frame.split("\n").find((line) => line.includes("▲"))!.indexOf("▲");
        expect(marker(after)).toBeGreaterThan(marker(before));
        for (const child of view.box.getChildren()) {
            expect(child.screenY + child.height).toBeLessThanOrEqual(view.box.screenY + view.box.height - 1);
        }
        state = handleModelJourneyKey(state, { name: "tab" }).state!;
        expect(state.modelFocus).toBe("list");
        state = chooseScope(state, "pool");
        view.update(state);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("Smarter");
    } finally { setup.renderer.destroy(); }
});

test("highlighted model details follow the row and distinguish verified, failed, and unknown facts", async () => {
    const setup = await createTestRenderer({ width: 140, height: 40 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const options = [{ ...rows[0]!, unverified: false, images: true },
            { ...rows[1]!, verificationError: "probe refused" }];
        let state = modelJourney({ ...base, allOptions: options }, "shortlist");
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

test("All restores aligned score and blended-price columns with top-pick, image, Pareto, and kept marks", async () => {
    const setup = await createTestRenderer({ width: 170, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const options = [{ ...rows[0]!, label: "Preferred", recommended: true, pooledRank: 0,
            waScore: 1629, pricing: { input: 3, output: 15 }, images: true, onPareto: true },
            { ...rows[1]!, label: "Steady", pooledRank: undefined, waScore: 1400, pricing: { input: 1, output: 4 } },
            { ...rows[2]!, label: "Unknown", pooledRank: undefined }];
        const state = chooseScope(modelJourney({ ...base, allOptions: options }, "switch"));
        view.update(state);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        const lines = frame.split("\n").map((line) => line.split("│")[0]!);
        const header = lines.find((line) => line.includes("WA Score*"))!;
        const preferred = lines.find((line) => line.includes("Preferred"))!;
        const steady = lines.find((line) => line.includes("Steady"))!;
        const unknown = lines.find((line) => line.includes("Unknown"))!;
        expect(header).toContain("3:1");
        expect(preferred).toContain("top pick");
        expect(preferred).toContain("P i ★");
        expect(preferred).toMatch(/1629\s+6\s/);
        expect(preferred).not.toContain("3/15");
        expect(steady).toContain("1.75");
        expect(preferred.indexOf("1629")).toBe(steady.indexOf("1400"));
        expect(header.indexOf("WA Score*") + "WA Score*".length).toBe(preferred.indexOf("1629") + 4);
        expect(unknown).not.toMatch(/\b0\b/);
        expect(frame).toContain("Full price");
        expect(frame).toContain("3/15");
        expect(frame).toContain("Blended price");
        expect(frame).not.toContain("full 3/15");
        expect(frame).not.toContain("blended 6 at");
        expect(frame).toContain("Models from your connected providers");
        expect(frame).toContain("Ctrl+K More: library, variants, refresh, defaults");
        const unknownState = { ...state, selectedIndex: state.options.findIndex((row) => row.label === "Unknown") };
        view.update(unknownState);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("full 3/15");
        view.update(handleModelJourneyKey(unknownState, { name: "a", ctrl: true }).state!);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("Models from your connected providers");
        expect(setup.captureCharFrame()).toContain("Ctrl+K More: library, variants, refresh, defaults");
        expect(frame).toContain("* WA Score: rating from blind comparisons");
        expect(frame).toContain("Model ID");
        expect(frame).toContain("Smarter");
        setup.resize(60, 44);
        view.update(state);
        await setup.renderOnce();
        const narrow = setup.captureCharFrame();
        expect(narrow).not.toContain("Full price");
        expect(narrow).toContain("full 3/15");
    } finally { setup.renderer.destroy(); }
});


test("All keeps its price band and footer inside a short terminal with cutoff and refresh notice", async () => {
    const setup = await createTestRenderer({ width: 110, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const state = chooseScope(modelJourney(base, "switch"));
        view.update({ ...state, intelligenceCutoff: "1400", journeyNotice: "Catalog refreshed." });
        await setup.renderOnce();
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(23);
        expect(setup.captureCharFrame()).toContain("switch model");
    } finally { setup.renderer.destroy(); }
});


test("journey panels stay vertically centred as scope, content, and terminal size change", async () => {
    const setup = await createTestRenderer({ width: 140, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const shortlist = modelJourney(base, "switch");
        for (const state of [shortlist, chooseScope(shortlist), modelJourney(base, "shortlist")]) {
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
        expect(setup.captureCharFrame()).not.toContain("Switch model");
    } finally { setup.renderer.destroy(); }
});


test("Ctrl+D/U page without changing membership and Ctrl+S retains the row toggle", () => {
    const options = Array.from({ length: 30 }, (_, index) => ({ ...rows[0]!, value: `p/${index}`, model: `${index}`, pooledRank: index }));
    for (const journey of ["switch", "shortlist"] as const) {
        const start = modelJourney({ ...base, allOptions: options }, journey);
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
        if (journey === "shortlist") {
            expect(handleTuiSettingsPickerKey(start, { name: "k", ctrl: true, shift: true }).poolBulk).toBeUndefined();
        } else {
            expect(handleTuiSettingsPickerKey(start, { name: "s", ctrl: true, shift: true }).state?.modelJourney).toBe("switch");
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
        for (const mode of ["switch", "shortlist"] as const) {
            const state = mode === "switch" ? chooseScope(modelJourney({ ...base, allOptions: options }, mode))
                : modelJourney({ ...base, allOptions: options }, mode);
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
                if (mode === "switch") {
                    expect(frame).toContain("Provider catalog");
                    expect(frame).not.toContain("[ Catalog ]");
                    expect(frame).not.toContain("[ Library ]");
                    expect(frame).toContain("Models from your connected providers");
                }
            }
        }
    } finally { setup.renderer.destroy(); }
});


test("Switch scope keeps its card and footer fixed; Tab reaches the slider and restores the model", async () => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        for (const height of [44, 24]) {
            setup.resize(110, height);
            let state = modelJourney(base, "switch");
            let geometry: number[] | undefined;
            for (let i = 0; i < 4; i++) {
                view.update(state); await setup.renderOnce();
                const footer = setup.captureCharFrame().split("\n").findIndex((line) => line.includes("^d/^u page"));
                const next = [view.box.screenY, view.box.height, footer];
                if (geometry) expect(next).toEqual(geometry); else geometry = next;
                expect(view.box.screenY).toBeGreaterThanOrEqual(0);
                expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(height);
                state = chooseScope(state, state.tab === "all" ? "pool" : "all");
            }
        }
        let all = chooseScope(modelJourney(base, "switch"));
        all = updateTuiSettingsPickerSearch(all, "alpha").state!;
        const model = all.options[all.selectedIndex]?.model;
        view.update(all);
        expect(view.handleEditorKey(all, { name: "left" }).handled).toBe(true);
        all = handleTuiSettingsPickerKey(all, { name: "tab" }).state!;
        expect(all.modelFocus).toBe("intelligence");
        all = handleTuiSettingsPickerKey(all, { name: "right" }).state!;
        expect(all.intelligenceCutoff).toBe("1400");
        all = handleTuiSettingsPickerKey(all, { name: "tab" }).state!;
        expect(all.modelFocus).toBe("list");
        expect(all.options[all.selectedIndex]?.model).toBe(model);
        expect(all.query).toBe("alpha");
    } finally { setup.renderer.destroy(); }
});

test("Tab cycles interactive sections without changing scope or model; reverse Tab reverses it", () => {
    for (const tab of ["pool", "all"] as const) {
        let state = { ...chooseScope(modelJourney(base, "switch"), tab), selectedIndex: 1 };
        const selected = state.options[state.selectedIndex]?.value;
        const sections = journeySections(state);
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
    const state = { ...modelJourney(base, "switch"), modelFocus: "list" as const };
    expect(journeyFooter(state).split("\n")[1]).toBe("↑↓ ^d^u choose · ⏎ switch model · ^s remove from library · space fold");
    for (const focus of ["scope", "sort", "search", "more"] as const) {
        expect(journeyFooter({ ...state, modelFocus: focus })).not.toContain("^d^u");
    }
    for (const [name, index] of [["d", state.options.length - 1], ["u", 0]] as const) {
        expect(handleModelJourneyKey(state, { name, ctrl: true }).state?.selectedIndex).toBe(index);
    }
});

test("Manage offers one model action and explains catalog visibility on its own line", () => {
    const state = modelJourney(base, "shortlist");
    expect(journeyFooter(state).split("\n")).toEqual([
        "⏎ / Ctrl+S  Add to library",
        "Ctrl+A  Show extra variants and older models",
        "↑↓ choose · space fold · Tab sections",
        "Ctrl+R Rename · Ctrl+Y Verify · Esc Back",
    ]);
    expect(journeyFooter({ ...state, modelFocus: "search" }).split("\n")[2]).toBe("Type to search · ↑↓ sections · Tab sections");
    expect(journeyFooter({ ...state, selectedIndex: 1 })).toContain("Remove from library");
    expect(journeyFooter({ ...state, revealAll: true }).split("\n")[1]).toBe("Ctrl+A  Hide extra variants and older models");
    for (const query of ["", "beta"]) for (const shift of [false, true]) {
        const filtered = updateTuiSettingsPickerSearch(state, query).state!;
        const ignored = handleTuiSettingsPickerKey(filtered, { name: "k", ctrl: true, shift });
        expect(ignored.poolBulk).toBeUndefined();
        expect(ignored.poolToggle).toBeUndefined();
        expect(ignored.state).toBe(filtered);
    }
});

test("cutoff counts and result filtering keep the search, slider, card, and footer still", async () => {
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
            let state = chooseScope(modelJourney({ ...base, allOptions: options }, "switch"));
            state = handleTuiSettingsPickerKey(state, { name: "tab", shift: true }).state!;
            let expected: number[] | undefined;
            for (let step = 0; step < 7; step++) {
                view.update(state); await setup.renderOnce();
                const frame = setup.captureCharFrame();
                const lines = frame.split("\n");
                const anchors = ["Search models", "Smarter", "Ctrl+K More", "Tab / Shift+Tab"].map((text) => lines.findIndex((line) => line.includes(text)));
                expect(anchors.every((y) => y >= 0)).toBe(true);
                const geometry = [view.box.screenY, view.box.height, ...anchors];
                if (expected) expect(geometry).toEqual(expected); else expected = geometry;
                expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(height!);
                expect(frame).not.toContain("fewer models");
                expect(journeyHeader(state)).not.toContain("^a");
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
            const state = { ...chooseScope(modelJourney(base, "switch")), modelFocus, query: "bta", queryCursor: 1 };
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
    const parent = { ...chooseScope(modelJourney(base, "switch")), modelFocus: "scope" as const };
    const menu = modelJourneyScope(parent);
    expect(handleTuiSettingsPickerKey(menu, { name: "escape" }).state).toBe(parent);
    for (const selectedIndex of [0, 1]) {
        const selected = handleTuiSettingsPickerKey({ ...menu, selectedIndex }, { name: "enter" }).state!;
        expect(selected.modelFocus).toBe("list");
        expect(selected.tab).toBe(selectedIndex === 0 ? "pool" : "all");
        expect(selected.query).toBe(parent.query);
        expect(selected.intelligenceCutoff).toBe(parent.intelligenceCutoff);
    }
});


test("the switch tip cycles and every line fits one row", () => {
    for (const tip of MODEL_SWITCH_TIPS) expect(tip.length).toBeLessThanOrEqual(64);
    const seen = MODEL_SWITCH_TIPS.map((_, turn) => modelSwitchTip(turn));
    expect(seen).toEqual([...MODEL_SWITCH_TIPS]);
    expect(modelSwitchTip(MODEL_SWITCH_TIPS.length)).toBe(MODEL_SWITCH_TIPS[0]);
    expect(modelSwitchTip(-1)).toBe(MODEL_SWITCH_TIPS[MODEL_SWITCH_TIPS.length - 1]);
});

const priced = [
    { value: "p/z", provider: "p", model: "z", label: "Zeta", description: "", pooledRank: 0, pricing: { input: 1, output: 2 } },
    { value: "p/m", provider: "p", model: "m", label: "Mu", description: "", pooledRank: 1 },
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", pooledRank: 2, pricing: { input: 3, output: 15 } },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", pooledRank: 3, pricing: { input: 0.5, output: 12 } },
    { value: "q/c", provider: "q", model: "c", label: "Gamma", description: "", pooledRank: 4, pricing: { input: 0.1, output: 0.1 } },
];

function chooseSort(state: TuiSettingsPickerState, label: string): TuiSettingsPickerState {
    const menu = modelJourneySort({ ...state, modelFocus: "sort" });
    return handleTuiSettingsPickerKey({ ...menu, selectedIndex: menu.options.findIndex((row) => row.label === label) }, { name: "enter" }).state!;
}

test("sort orders models inside each provider group, unpriced last", () => {
    const state = modelJourney({ ...base, allOptions: priced }, "switch");
    const labels = (next: TuiSettingsPickerState) => next.options.map((row) => row.label);
    expect(journeySort(state)).toBe("library");
    expect(labels(state)).toEqual(["Zeta", "Mu", "Alpha", "Beta", "Gamma"]);
    expect(labels(chooseSort(state, "A to Z"))).toEqual(["Alpha", "Beta", "Mu", "Zeta", "Gamma"]);
    // 3:1 input:output puts Zeta (1.25) ahead of Beta (3.38) and Alpha (6); Gamma stays under its own heading.
    expect(labels(chooseSort(state, "Cheapest first"))).toEqual(["Zeta", "Beta", "Alpha", "Mu", "Gamma"]);
});

test("Library order is offered only in Library models and Catalog falls back to A to Z", () => {
    const state = modelJourney({ ...base, allOptions: priced }, "switch");
    expect(modelJourneySort(state).options.map((row) => row.label)).toEqual(["Library order", "A to Z", "Cheapest first"]);
    const catalog = chooseScope(state);
    expect(journeySort(catalog)).toBe("az");
    expect(modelJourneySort(catalog).options.map((row) => row.label)).toEqual(["A to Z", "Cheapest first"]);
    const cheap = chooseScope(chooseSort(state, "Cheapest first"));
    expect(journeySort(cheap)).toBe("price");
});

test("confirming a sort keeps the highlighted model while cancelling restores Sort", () => {
    const state = { ...modelJourney({ ...base, allOptions: priced }, "switch"), selectedIndex: 2 };
    const sorted = chooseSort(state, "A to Z");
    expect(sorted.modelFocus).toBe("list");
    expect(sorted.options[sorted.selectedIndex]?.label).toBe("Alpha");
    const menu = handleTuiSettingsPickerKey({ ...state, modelFocus: "sort" }, { name: "enter" }).state!;
    expect(menu.title).toBe("Sort models");
    const back = handleTuiSettingsPickerKey(menu, { name: "escape" }).state!;
    expect(back.modelFocus).toBe("sort");
    expect(back.options.map((row) => row.label)).toEqual(state.options.map((row) => row.label));
});

test("sort chip sits beside the scope chip when wide and on its own line when narrow", async () => {
    for (const width of [110, 60, 40]) {
        const setup = await createTestRenderer({ width, height: 44 });
        const view = createTuiSettingsPickerView(setup.renderer);
        setup.renderer.root.add(view.surface); view.surface.visible = true;
        let opened = 0;
        view.onSort = () => { opened++; };
        try {
            view.update(modelJourney({ ...base, allOptions: priced }, "switch")); await setup.renderOnce();
            const filter = view.box.getChildren().find((node) => node.id === "model-filter")!;
            const scope = filter.getChildren().find((node) => node.id === "model-scope")!;
            const sort = filter.getChildren().find((node) => node.id === "model-sort")!;
            const line = setup.captureCharFrame().split("\n")[sort.screenY]!;
            expect(line.slice(sort.screenX)).toStartWith(" › Library order ▾");
            if (width === 110) {
                expect(sort.screenY).toBe(scope.screenY);
                expect(sort.screenX).toBe(scope.screenX + scope.width + 2);
            } else {
                expect(sort.screenY).toBe(scope.screenY + 1);
                expect(sort.screenX).toBe(filter.screenX);
            }
            await setup.mockMouse.click(sort.screenX + 1, sort.screenY);
            expect(opened).toBe(1);
        } finally { setup.renderer.destroy(); }
    }
});

test("a host snapshot keeps the chosen sort", () => {
    const sorted = chooseSort(modelJourney({ ...base, allOptions: priced }, "switch"), "Cheapest first");
    expect(syncTuiModelPicker(sorted, undefined).journeySort).toBe("price");
});

test("an arrow leaves a Switch section only when it has no job there, edges included", () => {
    const press = (state: TuiSettingsPickerState, name: string) =>
        handleTuiSettingsPickerKey(state, { name, ...(name === "space" ? { sequence: " " } : {}) }).state!;
    const at = (state: TuiSettingsPickerState, modelFocus: TuiSettingsPickerState["modelFocus"]) => ({ ...state, modelFocus });
    for (const tab of ["pool", "all"] as const) {
        const state = chooseScope(modelJourney(base, "switch"), tab);
        const middle = tab === "all" ? "intelligence" : "list";
        // Chips use no arrows, so every arrow walks the Tab order and wraps.
        for (const name of ["right", "down"]) {
            expect(press(at(state, "scope"), name).modelFocus).toBe("sort");
            expect(press(at(state, "sort"), name).modelFocus).toBe("search");
        }
        for (const name of ["left", "up"]) {
            expect(press(at(state, "sort"), name).modelFocus).toBe("scope");
            expect(press(at(state, "scope"), name).modelFocus).toBe("more");
        }
        expect(press(at(state, "scope"), "space").title).toBe("Show models");
        expect(press(at(state, "sort"), "space").title).toBe("Sort models");
        // Search: up/down move sections.
        expect(press(at(state, "search"), "up").modelFocus).toBe("sort");
        expect(press(at(state, "search"), "down").modelFocus).toBe(middle);
        // Models: up/down never leave, even at the edges; left/right are Tab.
        const top = { ...at(state, "list"), selectedIndex: 0 };
        expect(press(top, "up").modelFocus).toBe("list");
        const bottom = { ...at(state, "list"), selectedIndex: state.options.length - 1 };
        expect(press(bottom, "down").modelFocus).toBe("list");
        expect(press(at(state, "list"), "right").modelFocus).toBe("more");
        expect(press(at(state, "list"), "left").modelFocus).toBe(tab === "all" ? "intelligence" : "search");
        // More: back to Models, forward wraps to Filter Models.
        for (const name of ["up", "left"]) expect(press(at(state, "more"), name).modelFocus).toBe("list");
        for (const name of ["down", "right"]) expect(press(at(state, "more"), name).modelFocus).toBe("scope");
        // Search keeps left/right for the caret.
        expect(press(at(state, "search"), "left").modelFocus).toBe("search");
        expect(press(at(state, "more"), "space").title).toBe("More");
    }
    const all = { ...chooseScope(modelJourney(base, "switch")), modelFocus: "intelligence" as const };
    expect(press(all, "up").modelFocus).toBe("search");
    expect(press(all, "down").modelFocus).toBe("list");
    expect(press(all, "right").intelligenceCutoff).toBe("1400");
    expect(press(all, "space")).toEqual(all);
});

test("Model Library has Search and Models sections under the same arrow rule", async () => {
    const press = (state: TuiSettingsPickerState, name: string, shift = false) =>
        handleTuiSettingsPickerKey(state, { name, shift, ...(name === "space" ? { sequence: " " } : {}) });
    const library = modelJourney(base, "shortlist");
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
        const state = { ...modelJourney(base, "switch"), query: "a", queryCursor: 1 };
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
