import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { handleModelJourneyKey, modelJourney, journeyHeader, journeyModels } from "../../clients/tui/model-journeys.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, startTuiProviderPicker, withTuiPickerParent, syncTuiModelPicker, updateTuiSettingsPickerSearch, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";

const rows = [
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", waScore: 1550 },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", pooledRank: 0, unverified: true },
    { value: "q/c", provider: "q", model: "c", label: "Gamma", description: "", pooledRank: 1 },
];
const base: TuiSettingsPickerState = { kind: "model", allOptions: rows, options: rows, selectedIndex: 0, query: "" };

test("switching has only one verb in either scope and never toggles membership", () => {
    let state = modelJourney(base, "switch");
    expect(state.options.map((row) => row.model)).toEqual(["b", "c"]);
    expect(journeyHeader(state)).not.toContain("Cutoff");
    expect(handleModelJourneyKey(state, { name: "enter" }).selection).toEqual({ kind: "model", provider: "p", model: "b" });
    state = handleModelJourneyKey(state, { name: "tab" }).state!;
    expect(state.options).toHaveLength(3);
    expect(handleModelJourneyKey(state, { name: "enter" }).poolToggle).toBeUndefined();
    expect(handleModelJourneyKey(state, { name: "r", ctrl: true }).refreshAllCatalogs).toBe(true);
});

test("shortlist Enter only keeps or unkeeps and row verbs are chords", () => {
    const state = modelJourney(base, "shortlist");
    expect(state.options.map((row) => row.model)).toEqual(["b", "c", "a"]);
    expect(handleModelJourneyKey(state, { name: "enter" }).poolToggle).toEqual({ action: "remove", provider: "p", model: "b" });
    expect(handleModelJourneyKey(state, { name: "enter" }).selection).toBeUndefined();
    expect(handleModelJourneyKey(state, { name: "r", ctrl: true }).poolName?.model).toBe("b");
    expect(handleModelJourneyKey(state, { name: "y", ctrl: true }).poolVerify?.model).toBe("b");
    expect(handleModelJourneyKey(state, { name: "r" }).handled).toBe(false);
    expect(journeyHeader(state)).toContain("2 kept of 3 discovered · 1 verified");
});

test("cutoff excludes unscored models only in all scope; search scopes bulk actions", () => {
    let state = { ...modelJourney(base, "switch"), tab: "all" as const, intelligenceCutoff: "1500" as const };
    expect(journeyModels(state).map((row) => row.model)).toEqual(["a"]);
    expect(journeyHeader(state)).toContain("2 hidden below the cutoff, including 2 unscored");
    const manage = updateTuiSettingsPickerSearch(modelJourney(base, "shortlist"), "beta").state!;
    expect(handleModelJourneyKey(manage, { name: "u", ctrl: true }).poolBulk?.models.map((row) => row.model)).toEqual(["b"]);
});

test("live shortlist search accepts spaces and row actions do not appear as another screen", async () => {
    const setup = await createTestRenderer({ width: 110, height: 32 });
    const view = createTuiSettingsPickerView(setup.renderer);
    try {
        let state = modelJourney(base, "shortlist");
        view.update(state);
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        for (const name of ["b", "space", "p"]) {
            state = view.handleEditorKey(state, { name, sequence: name === "space" ? " " : name }).state ?? state;
            view.update(state);
        }
        expect(state.query).toBe("b p");
        expect(state.options.map((row) => row.model)).toEqual(["b"]);
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
    expect(switched.options[0]?.unavailable).toBe(true);
    expect(handleModelJourneyKey(switched, { name: "enter" }).selection).toBeUndefined();
    const managed = modelJourney(switched, "shortlist");
    expect(journeyHeader(managed)).toContain("1 kept of 0 discovered");
    expect(handleModelJourneyKey(managed, { name: "enter" }).poolToggle?.action).toBe("remove");
});

test("model journey cards contain the footer and padding for empty, short, and full lists", async () => {
    const setup = await createTestRenderer({ width: 110, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
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
    setup.renderer.root.add(view.box);
    view.box.visible = true;
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
