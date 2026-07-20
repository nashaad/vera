import { expect, test } from "bun:test";

import {
    handleTuiSettingsPickerKey,
    renderTuiSettingsPicker,
    startTuiSettingsPicker,
} from "../../clients/tui/settings-picker.ts";

test("model picker keeps the current model selected", () => {
    const state = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "approve_for_me",
    );

    expect(state.options[state.selectedIndex]?.value).toBe("z-ai/glm-5.2");
    expect(renderTuiSettingsPicker(state)).toContain("GLM-5.2");
});

test("model picker filters its choices as the user types", () => {
    const state = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "max",
        "approve_for_me",
    );
    const first = handleTuiSettingsPickerKey(state, { name: "g" });
    const second = handleTuiSettingsPickerKey(first.state ?? state, { name: "l" });

    expect(second.state?.query).toBe("gl");
    expect(second.state?.options.map((option) => option.value)).toEqual([
        "z-ai/glm-5.2",
    ]);
    expect(renderTuiSettingsPicker(second.state ?? state)).toContain("Search  gl");
});

test("Kimi reasoning picker only offers its supported max effort", () => {
    const reasoning = startTuiSettingsPicker(
        "reasoning",
        "moonshotai/kimi-k3",
        "low",
        "approve_for_me",
        ["max"],
    );
    const selected = handleTuiSettingsPickerKey(reasoning, { name: "enter" });
    expect(selected.selection).toEqual({
        kind: "reasoning",
        reasoningEffort: "max",
    });
    expect(reasoning.options.map((option) => option.value)).toEqual(["max"]);
});

test("settings picker selects permissions with arrows", () => {
    const permissions = startTuiSettingsPicker(
        "permissions",
        "moonshotai/kimi-k3",
        "max",
        "approve_for_me",
    );
    const fullAccess = handleTuiSettingsPickerKey(
        permissions,
        { name: "down" },
    );
    expect(handleTuiSettingsPickerKey(
        fullAccess.state ?? permissions,
        { name: "enter" },
    ).selection).toEqual({
        kind: "permissions",
        mode: "full_access",
    });
});

test("escape closes the settings picker", () => {
    const state = startTuiSettingsPicker(
        "reasoning",
        "moonshotai/kimi-k3",
        "max",
        "approve_for_me",
    );

    expect(handleTuiSettingsPickerKey(state, { name: "escape" })).toEqual({
        handled: true,
    });
});
