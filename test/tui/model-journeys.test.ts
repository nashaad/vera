import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { handleModelJourneyKey, modelJourney, journeyHeader, journeyModels, journeyMatches, journeyWindow } from "../../clients/tui/model-journeys.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, startTuiProviderPicker, withTuiPickerParent, syncTuiModelPicker, updateTuiSettingsPickerSearch, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";

const rows = [
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", waScore: 1550 },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", pooledRank: 0, unverified: true },
    { value: "q/c", provider: "q", model: "c", label: "Gamma", description: "", pooledRank: 1 },
];
const base: TuiSettingsPickerState = { kind: "model", allOptions: rows, options: rows, selectedIndex: 0, query: "" };

test("Enter switches in either scope without toggling membership", () => {
    let state = modelJourney(base, "switch");
    expect(state.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["b", "c"]);
    expect(journeyHeader(state)).not.toContain("Cutoff");
    expect(handleModelJourneyKey(state, { name: "enter" }).selection).toEqual({ kind: "model", provider: "p", model: "b" });
    state = handleModelJourneyKey(state, { name: "tab" }).state!;
    expect(journeyMatches(state)).toHaveLength(3);
    expect(handleModelJourneyKey(state, { name: "enter" }).poolToggle).toBeUndefined();
    expect(handleModelJourneyKey(state, { name: "r", ctrl: true }).refreshAllCatalogs).toBe(true);
});

test("shortlist Enter only keeps or unkeeps and row verbs are chords", () => {
    const state = modelJourney(base, "shortlist");
    expect(state.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["b", "c", "a"]);
    expect(handleModelJourneyKey(state, { name: "enter" }).poolToggle).toEqual({ action: "remove", provider: "p", model: "b" });
    expect(handleModelJourneyKey(state, { name: "enter" }).selection).toBeUndefined();
    expect(handleModelJourneyKey(state, { name: "r", ctrl: true }).poolName?.model).toBe("b");
    expect(handleModelJourneyKey(state, { name: "y", ctrl: true }).poolVerify?.model).toBe("b");
    expect(handleModelJourneyKey(state, { name: "r" }).handled).toBe(false);
    expect(journeyHeader(state)).toContain("2 kept of 3 discovered · 1 verified");
});

test("cutoff excludes unscored models only in all scope; search scopes bulk actions", () => {
    let state = { ...modelJourney(base, "switch"), tab: "all" as const, intelligenceCutoff: "1500" as const };
    expect(journeyModels(state).filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["a"]);
    expect(journeyHeader(state)).toContain("2 hidden below the cutoff, including 2 unscored");
    const manage = updateTuiSettingsPickerSearch(modelJourney(base, "shortlist"), "beta").state!;
    expect(handleModelJourneyKey(manage, { name: "k", ctrl: true, shift: true }).poolBulk?.models.map((row) => row.model)).toEqual(["b"]);
});

test("live shortlist search accepts spaces and row actions do not appear as another screen", async () => {
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
        expect(frame).toContain("Manage shortlist");
        expect(frame).toContain("kept ✓");
        expect(frame).not.toContain("Actions");
    } finally { setup.renderer.destroy(); }
});

test("default assignment offers only verified shortlist models and both recovery routes", async () => {
    const { startTuiModelAssignmentPicker } = await import("../../clients/tui/settings-picker.ts");
    const pane = startTuiModelAssignmentPicker("eco", "eco", "", [
        { provider: "p", model: "a", label: "A", available: true, verified: false, levels: [] },
        { provider: "p", model: "b", label: "B", available: true, verified: true, levels: [] },
    ]);
    expect(pane.options.filter((row) => row.model !== undefined).map((row) => row.model)).toEqual(["b"]);
    expect(pane.options.some((row) => row.label === "Verify shortlisted models")).toBe(true);
    expect(pane.options.some((row) => row.label === "Manage shortlist")).toBe(true);
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
    expect(journeyHeader(managed)).toContain("1 kept of 0 discovered");
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
                    const footer = frame.findIndex((line) => line.includes(journey === "switch" ? "run it" : "keep or unkeep"));
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

test("plain provider groups keep shortlisted models first and headings never enter navigation", () => {
    const state = modelJourney(base, "shortlist");
    expect(state.options.map((row) => row.group)).toEqual(["Kept · p", "Kept · q", "p"]);
    expect(state.options.every((row) => row.model !== undefined && row.section === undefined)).toBe(true);
    for (const shift of [false, true]) for (const name of ["left", "right"]) {
        expect(handleModelJourneyKey(state, { name, shift }).state).toBe(state);
    }
    const next = handleModelJourneyKey(state, { name: "down" }).state!;
    expect(next.options[next.selectedIndex]?.model).toBe("c");
    const searched = updateTuiSettingsPickerSearch(state, "beta").state!;
    expect(searched.options[searched.selectedIndex]?.model).toBe("b");
    expect(handleModelJourneyKey(searched, { name: "enter" }).poolToggle?.model).toBe("b");
});

test("reduced catalogs hide old entries without hiding kept models or search results", () => {
    const options = [rows[0]!, { ...rows[1]!, hiddenByDefault: "old" as const },
        { ...rows[2]!, pooledRank: undefined, hiddenByDefault: "superseded" as const }];
    let state = handleModelJourneyKey(modelJourney({ ...base, allOptions: options }, "switch"), { name: "tab" }).state!;
    expect(journeyMatches(state).map((row) => row.model)).toEqual(["a", "b"]);
    expect(journeyHeader(state)).toContain("1 hidden (older, duplicate or superseded)");
    state = handleModelJourneyKey(state, { name: "a", ctrl: true }).state!;
    expect(journeyMatches(state)).toHaveLength(3);
    expect(journeyHeader(state)).toContain("1 included");
    state = handleModelJourneyKey(state, { name: "a", ctrl: true }).state!;
    const search = updateTuiSettingsPickerSearch(state, "gamma").state!;
    expect(search.options[search.selectedIndex]?.model).toBe("c");
    const managed = modelJourney({ ...base, allOptions: options }, "shortlist");
    expect(handleModelJourneyKey(managed, { name: "k", ctrl: true }).poolBulk?.models.map((row) => row.model)).toEqual(["a"]);
});

test("large provider sections stay open and bounded windows retain provider context", () => {
    const options = Array.from({ length: 60 }, (_, index) => ({
        ...rows[0]!, value: JSON.stringify(["p", `model-${index}`]), model: `model-${index}`, label: `Model ${index}`,
    }));
    let state = handleModelJourneyKey(modelJourney({ ...base, allOptions: options }, "switch"), { name: "tab" }).state!;
    expect(state.options).toHaveLength(60);
    state = { ...state, selectedIndex: 40 };
    const window = journeyWindow(state, 12);
    expect(window.length).toBeLessThanOrEqual(12);
    expect(window[0]?.heading).toBe("p");
    expect(window.some((row) => row.index === state.selectedIndex)).toBe(true);
    const refreshed = syncTuiModelPicker(state, { provider: "p", model: "model-0",
        availableModels: options.map((row) => ({ provider: row.provider, model: row.model, label: row.label, description: "", levels: [] })) });
    expect(refreshed.collapsed ?? []).toEqual(state.collapsed ?? []);
    expect(refreshed.options[refreshed.selectedIndex]?.value).toBe(state.options[state.selectedIndex]?.value);
});

test("provider headings have a blank row between groups inside the card", async () => {
    const setup = await createTestRenderer({ width: 110, height: 32 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        view.update(modelJourney(base, "shortlist"));
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const heading = lines.findIndex((line) => line.includes("Kept · q"));
        expect(heading).toBeGreaterThan(0);
        expect(lines[heading - 1]?.split("│")[0]?.trim()).toBe("");
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
        let state = handleModelJourneyKey(modelJourney(base, "switch"), { name: "tab" }).state!;
        state = { ...state, selectedIndex: 0 };
        state = handleModelJourneyKey(state, { name: "up" }).state!;
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
        state = handleModelJourneyKey(state, { name: "down" }).state!;
        expect(state.modelFocus).toBe("list");
        state = handleModelJourneyKey(state, { name: "tab" }).state!;
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
        const state = handleModelJourneyKey(modelJourney({ ...base, allOptions: options }, "switch"), { name: "tab" }).state!;
        view.update(state);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        const lines = frame.split("\n").map((line) => line.split("│")[0]!);
        const header = lines.find((line) => line.includes("WA Score*"))!;
        const preferred = lines.find((line) => line.includes("Preferred"))!;
        const steady = lines.find((line) => line.includes("Steady"))!;
        const unknown = lines.find((line) => line.includes("Unknown"))!;
        expect(header).toContain("7:2:1");
        expect(preferred).toContain("top pick");
        expect(preferred).toContain("P i ★");
        expect(preferred).toContain("4.2");
        expect(preferred).not.toContain("3/15");
        expect(steady).toContain("1.3");
        expect(preferred.indexOf("1629")).toBe(steady.indexOf("1400"));
        expect(header.indexOf("WA Score*") + "WA Score*".length).toBe(preferred.indexOf("1629") + 4);
        expect(unknown).not.toMatch(/\b0\b/);
        expect(frame).toContain("Full price");
        expect(frame).toContain("3/15");
        expect(frame).toContain("Blended price");
        expect(frame).not.toContain("full 3/15");
        expect(frame).not.toContain("blended 4.2 at");
        expect(frame).toContain("Catalog: fewer models");
        expect(frame).toContain("show every model");
        const unknownState = { ...state, selectedIndex: state.options.findIndex((row) => row.label === "Unknown") };
        view.update(unknownState);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).not.toContain("full 3/15");
        view.update(handleModelJourneyKey(unknownState, { name: "a", ctrl: true }).state!);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("Catalog: all models");
        expect(setup.captureCharFrame()).toContain("show fewer");
        expect(frame).toContain("* WA Score: an Elo rating");
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
        const state = handleModelJourneyKey(modelJourney(base, "switch"), { name: "tab" }).state!;
        view.update({ ...state, intelligenceCutoff: "1400", journeyNotice: "Catalog refreshed." });
        await setup.renderOnce();
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(23);
        expect(setup.captureCharFrame()).toContain("run it");
    } finally { setup.renderer.destroy(); }
});


test("journey panels stay vertically centred as scope, content, and terminal size change", async () => {
    const setup = await createTestRenderer({ width: 140, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const shortlist = modelJourney(base, "switch");
        for (const state of [shortlist, handleModelJourneyKey(shortlist, { name: "tab" }).state!, modelJourney(base, "shortlist")]) {
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
            expect(handleTuiSettingsPickerKey(start, { name: "k", ctrl: true, shift: true }).poolBulk?.action).toBe("remove");
        } else {
            expect(handleTuiSettingsPickerKey(start, { name: "s", ctrl: true, shift: true }).state?.modelJourney).toBe("shortlist");
            let all = handleTuiSettingsPickerKey(start, { name: "tab" }).state!;
            all = handleTuiSettingsPickerKey(all, { name: "right" }).state!;
            all = handleTuiSettingsPickerKey(all, { name: "down" }).state!;
            expect(handleTuiSettingsPickerKey(all, { name: "s", ctrl: true }).poolToggle?.action).toBe("remove");
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
            const state = mode === "switch" ? handleTuiSettingsPickerKey(modelJourney({ ...base, allOptions: options }, mode), { name: "tab" }).state!
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
                expect(frame).not.toContain("▶");
                expect(frame).not.toContain("▼");
                if (mode === "switch") {
                    expect(frame).toContain("All models");
                    expect(frame).not.toContain("[ All models ]");
                    expect(frame).not.toContain("[ Shortlist ]");
                    expect(frame).toContain("Shortlist");
                    expect(frame).toContain("Catalog: fewer models");
                }
            }
        }
    } finally { setup.renderer.destroy(); }
});


test("Switch scope keeps its card and footer fixed; Left enters the slider and Down returns to the selected model", async () => {
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
                state = handleTuiSettingsPickerKey(state, { name: "tab" }).state!;
            }
        }
        let all = handleTuiSettingsPickerKey(modelJourney(base, "switch"), { name: "tab" }).state!;
        all = updateTuiSettingsPickerSearch(all, "alpha").state!;
        const model = all.options[all.selectedIndex]?.model;
        view.update(all);
        expect(view.handleEditorKey(all, { name: "left" }).handled).toBe(false);
        all = handleTuiSettingsPickerKey(all, { name: "left" }).state!;
        expect(all.modelFocus).toBe("intelligence");
        all = handleTuiSettingsPickerKey(all, { name: "right" }).state!;
        expect(all.intelligenceCutoff).toBe("1400");
        all = handleTuiSettingsPickerKey(all, { name: "down" }).state!;
        expect(all.modelFocus).toBe("list");
        expect(all.options[all.selectedIndex]?.model).toBe(model);
        expect(all.query).toBe("alpha");
    } finally { setup.renderer.destroy(); }
});
