import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { modelJourney, journeyModels } from "../../clients/tui/model-journeys.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";

const rows = [
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", waScore: 1550, pooledRank: 0 },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", waScore: 1600 },
    { value: "p/c", provider: "p", model: "c", label: "Gamma", description: "", waScore: 1550, hiddenByDefault: "old" as const },
];
const base = modelJourney({ kind: "model", options: rows, allOptions: rows, query: "", selectedIndex: 0 }, "switch");
const more = { name: "k", ctrl: true };

test("More returns to the exact picker, and only its two catalog actions can run", () => {
    for (const modelFocus of ["list", "intelligence"] as const) {
        const filtered = { ...base, tab: "all" as const, intelligenceCutoff: "1500" as const,
            query: "p", queryCursor: 0, selectedIndex: 1, modelFocus };
        const parent = { ...filtered, options: journeyModels(filtered) };
        let menu = handleTuiSettingsPickerKey(parent, more).state!;
        expect(menu.kind).toBe("model_menu");
        expect(menu.options.map((row) => row.label)).toEqual(["Show extra variants and older models", "Refresh model catalog"]);
        expect(handleTuiSettingsPickerKey(menu, { name: "escape" }).state).toBe(parent);
        expect(handleTuiSettingsPickerKey(menu, more).state).toBe(parent);
        for (const key of [{ name: "s", ctrl: true }, { name: "y", ctrl: true }, { name: "tab" }, { name: "a" }]) {
            expect(handleTuiSettingsPickerKey(menu, key)).toEqual({ state: menu, handled: true });
        }
        const revealed = handleTuiSettingsPickerKey(menu, { name: "enter" }).state!;
        expect(revealed.revealAll).toBe(true);
        expect(revealed.query).toBe(parent.query);
        expect(revealed.queryCursor).toBe(0);
        expect(revealed.modelFocus).toBe(modelFocus);
        expect(revealed.intelligenceCutoff).toBe("1500");
        expect(revealed.options[revealed.selectedIndex]?.value).toBe("p/b");
        expect(handleTuiSettingsPickerKey(revealed, more).state?.options[0]?.label).toBe("Hide extra variants and older models");
        menu = handleTuiSettingsPickerKey(menu, { name: "down" }).state!;
        expect(handleTuiSettingsPickerKey(menu, { name: "enter" })).toEqual({ state: parent, handled: true, refreshAllCatalogs: true });
    }
    const libraryMenu = handleTuiSettingsPickerKey(base, more).state!;
    expect(libraryMenu.options.map((row) => row.label)).toEqual(["Refresh model catalog"]);
    expect(handleTuiSettingsPickerKey(libraryMenu, { name: "escape" }).state).toBe(base);
});

test("the descriptive More hint opens with the mouse and its menu has no search or sections", async () => {
    const setup = await createTestRenderer({ width: 110, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    let state: TuiSettingsPickerState = { ...base, tab: "all", options: rows };
    const parent = state;
    view.onMore = () => { state = handleTuiSettingsPickerKey(state, more).state!; view.update(state); };
    view.pointer = { activate: (selectedIndex) => {
        state = handleTuiSettingsPickerKey({ ...state, selectedIndex }, { name: "enter" }).state!;
        view.update(state);
    } };
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        view.update(state); await setup.renderOnce();
        const before = setup.captureCharFrame();
        const lines = before.split("\n");
        const y = lines.findIndex((line) => line.includes("Ctrl+K More: variants, refresh"));
        expect(y).toBeGreaterThan(0);
        await setup.mockMouse.click(lines[y]!.indexOf("More"), y);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Show extra variants and older models");
        expect(frame).toContain("Refresh model catalog");
        expect(frame).toContain("⏎ select");
        expect(frame).not.toContain("Search");
        expect(frame).not.toContain("Smarter");
        expect(view.handleEditorKey(state, { name: "a" }).handled).toBe(false);
        expect(view.handleEditorPaste(state, "anything").handled).toBe(false);
        const menuLines = frame.split("\n");
        const actionY = menuLines.findIndex((line) => line.includes("Show extra"));
        await setup.mockMouse.click(menuLines[actionY]!.indexOf("Show extra"), actionY);
        expect(state.revealAll).toBe(true);
        expect(setup.renderer.getSelection() === null).toBe(true);
        state = handleTuiSettingsPickerKey(parent, more).state!;
        state = handleTuiSettingsPickerKey(state, { name: "escape" }).state!;
        view.update(state); await setup.renderOnce();
        expect(setup.captureCharFrame()).toBe(before);
    } finally { setup.renderer.destroy(); }
});

test("More wraps its actions within a narrow terminal", async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        view.update(handleTuiSettingsPickerKey({ ...base, tab: "all" }, more).state!);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("older models");
        expect(frame).toContain("Refresh model catalog");
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(20);
    } finally { setup.renderer.destroy(); }
});
