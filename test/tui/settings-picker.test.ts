import { expect, test } from "bun:test";

import {
    handleTuiSettingsPickerKey,
    renderTuiSettingsPicker,
    startTuiSettingsPicker,
} from "../../clients/tui/settings-picker.ts";

const availableModels = [
    {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        label: "Kimi K3",
        description: "primary long-context model",
    },
    {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        description: "fast fallback model",
    },
] as const;

test("model picker keeps the current model selected", () => {
    const state = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "approve_for_me",
        undefined,
        availableModels,
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
        undefined,
        availableModels,
    );
    const first = handleTuiSettingsPickerKey(state, { name: "g" });
    const second = handleTuiSettingsPickerKey(first.state ?? state, { name: "l" });

    expect(second.state?.query).toBe("gl");
    expect(second.state?.options.map((option) => option.value)).toEqual([
        "z-ai/glm-5.2",
    ]);
    expect(renderTuiSettingsPicker(second.state ?? state)).toContain("Search  gl");
});

test("every settings picker filters as the user types", () => {
    const reasoning = startTuiSettingsPicker(
        "reasoning",
        "z-ai/glm-5.2",
        "high",
        "approve_for_me",
    );
    const filteredReasoning = handleTuiSettingsPickerKey(reasoning, {
        name: "m",
    });
    expect(filteredReasoning.state?.options.map((option) => option.value))
        .toEqual(["medium", "max"]);

    const permissions = startTuiSettingsPicker(
        "permissions",
        "z-ai/glm-5.2",
        "high",
        "approve_for_me",
    );
    let filteredPermissions = permissions;
    for (const name of "full") {
        filteredPermissions = handleTuiSettingsPickerKey(
            filteredPermissions,
            { name },
        ).state ?? filteredPermissions;
    }
    expect(filteredPermissions.options.map((option) => option.value))
        .toEqual(["full_access"]);
    expect(renderTuiSettingsPicker(filteredPermissions))
        .toContain("Search  full");
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

test("GLM reasoning picker only offers its supported max effort", () => {
    const reasoning = startTuiSettingsPicker(
        "reasoning",
        "z-ai/glm-5.2",
        "off",
        "approve_for_me",
        ["max"],
    );

    expect(reasoning.options.map((option) => option.value)).toEqual(["max"]);
    expect(handleTuiSettingsPickerKey(reasoning, { name: "enter" }).selection)
        .toEqual({ kind: "reasoning", reasoningEffort: "max" });
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
