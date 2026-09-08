import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { modelJourney } from "../../clients/tui/model-journeys.ts";
import { createTuiSettingsPickerView, handleTuiSettingsPickerKey, setTuiSettingsPickerCutoff, type TuiSettingsPickerState } from "../../clients/tui/settings-picker.ts";

const options = [
    { value: "p/alpha", provider: "p", model: "alpha", label: "Alpha", description: "", waScore: 1550 },
    { value: "p/beta", provider: "p", model: "beta", label: "Beta", description: "", waScore: 1450 },
    { value: "p/gamma", provider: "p", model: "gamma", label: "Gamma", description: "" },
];

test("cutoff band and printed ticks accept mouse clicks at their rendered positions", async () => {
    for (const [width, journey] of [[110, true], [70, true], [50, true], [100, false]] as const) {
        const setup = await createTestRenderer({ width, height: 44 });
        const view = createTuiSettingsPickerView(setup.renderer);
        let state: TuiSettingsPickerState = { kind: "model", tab: "all", options, allOptions: options, selectedIndex: 0, query: "a" };
        if (journey) state = handleTuiSettingsPickerKey(modelJourney(state, "switch"), { name: "tab" }).state!;
        state = { ...state, query: journey ? "a" : "" };
        view.onCutoff = (cutoff) => { state = setTuiSettingsPickerCutoff(state, cutoff); view.update(state); };
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        const paint = async () => { view.update(state); await setup.renderOnce(); return setup.captureCharFrame().split("\n"); };
        try {
            let lines = await paint();
            const tickRow = lines.findIndex((line) => line.includes("1400") && line.includes("1600"));
            expect(tickRow).toBeGreaterThan(0);
            await setup.mockMouse.click(lines[tickRow]!.indexOf("any"), tickRow - 2);
            expect(state.modelFocus).toBe("intelligence");
            expect(state.intelligenceCutoff).toBe("any");
            expect(state.options[state.selectedIndex]?.value).toBe("p/alpha");
            for (const tick of ["any", "1400", "1450", "1500", "1550", "1600"] as const) {
                for (let offset = 0; offset < tick.length; offset++) {
                    lines = await paint();
                    const row = lines.findIndex((line) => line.includes("1400") && line.includes("1600"));
                    await setup.mockMouse.click(lines[row]!.indexOf(tick) + offset, row);
                    expect(state.intelligenceCutoff).toBe(tick);
                    expect(state.modelFocus).toBe("intelligence");
                    expect(state.query).toBe(journey ? "a" : "");
                }
            }
            expect(state.options.filter((row) => row.model !== undefined)).toHaveLength(0);
            lines = await paint();
            const trackRow = lines.findIndex((line) => line.includes("▲") && line.includes("─"));
            await setup.mockMouse.click(lines[trackRow]!.indexOf("─"), trackRow);
            expect(state.intelligenceCutoff).toBe("any");
            expect(state.options.filter((row) => row.model !== undefined)).toHaveLength(3);
            state = handleTuiSettingsPickerKey(state, { name: journey ? "down" : "tab" }).state!;
            expect(state.modelFocus).toBe("list");
        } finally { setup.renderer.destroy(); }
    }
});
