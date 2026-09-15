import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, startTuiExtensionPicker } from "../../clients/tui/settings-picker.ts";
import type { TuiExtensionPickerState } from "../../clients/tui/settings-picker-types.ts";

test("the shared picker searches sources and keeps arrows owned by their section", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    let state: TuiExtensionPickerState = startTuiExtensionPicker("Customize › Agents", [
        { id: "default", label: "default", description: "all tools" },
        { id: "explorer", label: "explorer", description: "Read sources" },
    ], undefined, [{ id: "preview", label: "preview", key: "enter" }], undefined, true);
    function paint(): void { view.update(state); view.focus(); }
    try {
        paint();
        for (const name of "expl") {
            state = view.handleExtensionEditorKey(state, { name, sequence: name }).state!;
            paint();
        }
        expect(state.query).toBe("expl");
        expect(state.options.map((row) => row.value)).toEqual(["explorer"]);
        expect(state.searchFocused).toBe(true);
        state = handleTuiSettingsPickerKey(state, { name: "down" }).state!;
        expect(state.searchFocused).toBe(false);
        expect(state.selectedIndex).toBe(0);
        state = handleTuiSettingsPickerKey(state, { name: "down" }).state!;
        expect(state.selectedIndex).toBe(0);
        expect(handleTuiSettingsPickerKey(state, { name: "enter" }).selection?.rowId).toBe("explorer");
        paint(); await setup.flush();
        expect(setup.captureCharFrame()).toContain("Customize › Agents");
        expect(setup.captureCharFrame()).toContain("explorer");
        expect(handleTuiSettingsPickerKey(state, { name: "escape" }).state).toBeUndefined();
    } finally { setup.renderer.destroy(); }
});
