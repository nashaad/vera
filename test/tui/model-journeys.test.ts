import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { handleModelJourneyKey, modelJourney, journeyHeader, journeyModels } from "../../clients/tui/model-journeys.ts";
import { createTuiSettingsPickerView, syncTuiModelPicker, updateTuiSettingsPickerSearch, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";

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
