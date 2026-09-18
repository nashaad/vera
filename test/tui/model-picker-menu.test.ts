import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { modelBrowse, browseModels } from "../../clients/tui/model-browse.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";
import { TUI_ACCENT, TUI_ELEMENT, TUI_MUTED, TUI_TEXT } from "../../clients/tui/palette.ts";
import { setTuiSettingsPickerCutoff } from "../../clients/tui/settings-picker.ts";

const rows = [
    { value: "p/a", provider: "p", model: "a", label: "Alpha", description: "", waScore: 1550, pooledRank: 0 },
    { value: "p/b", provider: "p", model: "b", label: "Beta", description: "", waScore: 1600 },
    { value: "p/c", provider: "p", model: "c", label: "Gamma", description: "", waScore: 1550, hiddenByDefault: "old" as const },
];
const base = modelBrowse({ kind: "model", options: rows, allOptions: rows, query: "", selectedIndex: 0 }, "browse");
const more = { name: "k", ctrl: true };

test("filter sort names its current value and separates label and value tones", async () => {
    const setup = await createTestRenderer({ width: 100, height: 36 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        for (const [browseSort, label] of [["library", "Favorite order"], ["az", "A to Z"], ["price", "Cheapest first"]] as const) {
            const menu = handleTuiSettingsPickerKey({ ...base, browseSort, modelFocus: "filters" }, { name: "enter" }).state!;
            view.update(menu); await setup.renderOnce();
            const lines = setup.captureCharFrame().split("\n");
            const y = lines.findIndex((line) => line.includes(`Sort: ${label}`));
            expect(y).toBeGreaterThan(0);
            const colors = setup.captureSpans().lines[y]!.spans.flatMap((span) =>
                Array.from({ length: span.text.length }, () => span.fg.toInts()));
            expect(colors[lines[y]!.indexOf("Sort:")]).toEqual(RGBA.fromHex(TUI_MUTED).toInts());
            expect(colors[lines[y]!.indexOf(label)]).toEqual(RGBA.fromHex(TUI_TEXT).toInts());
        }
    } finally { setup.renderer.destroy(); }
});

test("Clear filters has one blank row above it without adding a keyboard stop", async () => {
    const setup = await createTestRenderer({ width: 100, height: 36 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        const menu = handleTuiSettingsPickerKey({ ...base, modelFocus: "filters" }, { name: "enter" }).state!;
        const index = menu.options.findIndex((row) => row.value === "variants");
        const next = handleTuiSettingsPickerKey({ ...menu, selectedIndex: index }, { name: "down" }).state!;
        expect(next.options[next.selectedIndex]?.value).toBe("clear_filters");
        view.update(next); await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const variants = lines.findIndex((line) => line.includes("Show extra variants"));
        const clear = lines.findIndex((line) => line.includes("Clear filters"));
        expect(clear).toBe(variants + 2);
        expect(lines[clear - 1]!.trim()).toBe("");
    } finally { setup.renderer.destroy(); }
});

test.each([40, 100])("filter slider uses the existing scale and accepts mouse input at width %i", async (width) => {
    const setup = await createTestRenderer({ width, height: 30 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    let state = handleTuiSettingsPickerKey({ ...base, modelFocus: "filters" }, { name: "enter" }).state!;
    state = { ...state, selectedIndex: state.options.findIndex((row) => row.value === "cutoff") };
    view.onCutoff = (cutoff) => { state = setTuiSettingsPickerCutoff(state, cutoff); view.update(state); };
    try {
        view.update(state); await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const y = lines.findIndex((line) => line.includes("1400") && line.includes("1600"));
        expect(y).toBeGreaterThan(0);
        expect(lines.some((line) => line.includes("Any") && line.includes("Smarter"))).toBe(true);
        await setup.mockMouse.click(lines[y]!.indexOf("1550") + 1, y);
        expect(state.parent?.intelligenceCutoff).toBe("1550");
        expect(state.title).toBe("Filter and sort");
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(30);
    } finally { setup.renderer.destroy(); }
});

test("the filter menu scrolls to its last action on a small terminal", async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        let state = handleTuiSettingsPickerKey({ ...base, modelFocus: "filters" }, { name: "enter" }).state!;
        for (let step = 0; step < state.options.length; step++) state = handleTuiSettingsPickerKey(state, { name: "down" }).state!;
        view.update(state); await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("Clear filters");
        expect(setup.captureCharFrame()).not.toContain("> Clear filters");
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(20);
    } finally { setup.renderer.destroy(); }
});

test("More returns to the exact picker, and only its listed actions can run", () => {
    for (const modelFocus of ["list", "intelligence"] as const) {
        const filtered = { ...base, tab: "all" as const, intelligenceCutoff: "1500" as const,
            query: "p", queryCursor: 0, selectedIndex: 1, modelFocus };
        const parent = { ...filtered, options: browseModels(filtered) };
        let menu = handleTuiSettingsPickerKey(parent, more).state!;
        expect(menu.kind).toBe("model_menu");
        expect(menu.options.map((row) => row.label)).toEqual(["Add to favorites", "Show extra variants and older models", "Refresh model catalog", "Add/remove favorites", "Verify favorites", "Edit model defaults", "Configure providers"]);
        menu = handleTuiSettingsPickerKey(menu, { name: "down" }).state!;
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
        expect(handleTuiSettingsPickerKey(revealed, more).state?.options
            .find((row) => row.value === "variants")?.label).toBe("Hide extra variants and older models");
        menu = handleTuiSettingsPickerKey(menu, { name: "down" }).state!;
        expect(handleTuiSettingsPickerKey(menu, { name: "enter" })).toEqual({ state: parent, handled: true, refreshAllCatalogs: true });
    }
    const libraryMenu = handleTuiSettingsPickerKey(base, more).state!;
    expect(libraryMenu.options.map((row) => row.label)).toEqual(["Remove from favorites", "Refresh model catalog", "Add/remove favorites", "Verify favorites", "Edit model defaults", "Configure providers"]);
    expect(handleTuiSettingsPickerKey(libraryMenu, { name: "escape" }).state).toBe(base);
});

test.each([110, 124])("Manage models opens with the mouse at width %i", async (width) => {
    const setup = await createTestRenderer({ width, height: 44 });
    const view = createTuiSettingsPickerView(setup.renderer);
    let state: TuiSettingsPickerState = { ...base, tab: "all", options: rows };
    view.onBrowseAction = (modelFocus) => {
        state = handleTuiSettingsPickerKey({ ...state, modelFocus }, { name: "enter" }).state!;
        view.update(state);
    };
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        view.update(state); await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        const y = lines.findIndex((line) => line.includes("Manage models"));
        expect(y).toBeGreaterThan(0);
        await setup.mockMouse.click(lines[y]!.indexOf("Manage models"), y);
        await setup.renderOnce();
        expect(state.kind).toBe("model_menu");
        expect(setup.captureCharFrame()).toContain("Refresh model catalog");
        expect(setup.captureCharFrame()).toContain("Remove from favorites");
        expect(setup.captureCharFrame()).not.toContain("> Remove from favorites");
        expect(view.handleEditorKey(state, { name: "a" }).handled).toBe(false);
        const returned = handleTuiSettingsPickerKey(state, { name: "escape" }).state!;
        expect(returned.modelFocus).toBe("more");
        expect(returned.query).toBe(base.query);
    } finally { setup.renderer.destroy(); }
});


test("More scrolls its actions and wraps them within a narrow terminal", async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        let menu = handleTuiSettingsPickerKey({ ...base, tab: "all" }, more).state!;
        menu = handleTuiSettingsPickerKey(menu, { name: "down" }).state!;
        view.update(menu);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("older models");
        expect(frame).toContain("Alpha · p");
        menu = handleTuiSettingsPickerKey(menu, { name: "down" }).state!;
        view.update(menu); await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("Refresh model catalog");
        expect(setup.captureCharFrame()).toContain("Reload connected catalogs");
        expect(view.box.screenY + view.box.height).toBeLessThanOrEqual(20);
    } finally { setup.renderer.destroy(); }
});

test("Manage models names the action target and explains each selected action", async () => {
    const setup = await createTestRenderer({ width: 100, height: 36 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface); view.surface.visible = true;
    try {
        const menu = handleTuiSettingsPickerKey({ ...base, tab: "all" }, more).state!;
        expect(menu.subtitle).toBe("Selected: Alpha · p");
        for (let selectedIndex = 0; selectedIndex < menu.options.length; selectedIndex++) {
            view.update({ ...menu, selectedIndex }); await setup.renderOnce();
            const lines = setup.captureCharFrame().split("\n");
            const target = lines.findIndex((line) => line.includes("Alpha · p"));
            const action = lines.findIndex((line) => line.includes(menu.options[selectedIndex]!.label));
            const helper = lines.findIndex((line) => line.includes(menu.options[selectedIndex]!.description));
            expect(target).toBeGreaterThan(0);
            expect(action).toBeGreaterThan(target);
            expect(helper).toBeGreaterThan(action);
            const favorite = lines.findIndex((line) => line.includes("Remove from favorites"));
            const general = lines.findIndex((line) => line.includes(menu.options[1]!.label));
            expect(favorite).toBe(target + 1);
            expect(general).toBe(favorite + 2);
            expect(lines[favorite + 1]!.trim()).toBe("");
        }
        const empty = handleTuiSettingsPickerKey({ ...base, options: [] }, more).state!;
        expect(empty.subtitle).toBeUndefined();
        expect(empty.options.some((option) => option.value === "library")).toBe(false);
    } finally { setup.renderer.destroy(); }
});
