import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    handleTuiSettingsPickerKey,
    startTuiSettingsMenu,
    startTuiSettingsPicker,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    createTuiSettingsPickerView,
    type TuiAnySettingsPickerState,
} from "../../clients/tui/settings-picker.ts";

// Most capable first, matching `CatalogModel.levels` ordering: the level
// pane renders whatever order it is given, and `inferReasoningSelection`'s
// "top level" fallback is the first entry, so the fixture order is load
// bearing for the pre-highlight tests below.
const REASONING_LEVELS = [
    { id: "max", label: "Max", description: "maximum available reasoning" },
    { id: "high", label: "High", description: "deeper reasoning" },
    { id: "medium", label: "Medium", description: "balanced reasoning" },
    { id: "low", label: "Low", description: "light reasoning" },
] as const;

// The pickers render as renderable rows, so their look is asserted against a
// captured frame rather than a string projection of the same state.
async function pickerFrame(
    state: TuiAnySettingsPickerState,
    width = 100,
    height = 40,
): Promise<string> {
    const setup = await createTestRenderer({ width, height });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(state);
    try {
        await setup.flush();
        return setup.captureCharFrame();
    } finally {
        setup.renderer.destroy();
    }
}

test("session picker filters durable interactive conversations and selects an agent", async () => {
    const state = startTuiSessionPicker([
        {
            id: "11111111-first-session",
            workspace: "/work/alpha",
            session_path: "/sessions/first.jsonl",
            kind: "interactive",
            status: "idle",
            title: "Fix the deployment race",
            updated_at: "2026-07-20T20:00:00.000Z",
        },
        {
            id: "22222222-background",
            workspace: "/work/beta",
            session_path: "/sessions/background.jsonl",
            kind: "background",
            status: "completed",
        },
    ], undefined, false, new Date("2026-07-20T21:00:00.000Z"));

    const frame = await pickerFrame(state);
    expect(frame).toContain("Fix the deployment race");
    expect(frame).toContain("1h ago · alpha");
    expect(frame).not.toContain("22222222");
    expect(handleTuiSettingsPickerKey(state, { name: "enter" }).selection)
        .toEqual({ kind: "session", sessionPath: "/sessions/first.jsonl" });
    expect(handleTuiSettingsPickerKey(
        state,
        { name: "delete" },
    ).trashCandidate).toEqual({
        sessionId: "11111111-first-session",
        label: "Fix the deployment race",
    });

    let searched = state;
    for (const name of "11111111-first-session") {
        searched = handleTuiSettingsPickerKey(searched, { name }).state
            ?? searched;
    }
    expect(searched.options).toHaveLength(1);
});

test("session picker excludes the current and unavailable conversations", async () => {
    const state = startTuiSessionPicker([
        session("current", "idle"),
        session("failed", "failed"),
        session("closed", "closed"),
    ], "current");

    expect(await pickerFrame(state)).toContain("No conversations found");
    expect(handleTuiSettingsPickerKey(state, { name: "enter" }).selection)
        .toBeUndefined();
    expect(await pickerFrame(startTuiSessionPicker([], undefined, true)))
        .toContain("Loading conversations…");
});

test("session picker hides empty chats and shows only meaningful live state", async () => {
    const state = startTuiSessionPicker([
        {
            ...session("empty", "idle"),
            updated_at: "2026-07-20T20:00:00.000Z",
        },
        {
            ...session("working", "working"),
            title: "Investigate the host",
            updated_at: "2026-07-20T20:00:00.000Z",
        },
    ], undefined, false, new Date("2026-07-20T21:00:00.000Z"));

    const rendered = await pickerFrame(state);
    expect(rendered).not.toContain("empty");
    expect(rendered).toContain("Investigate the host");
    expect(rendered).toContain("working · alpha");
});

test("session rows stay on one line at 80 columns", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(startTuiSessionPicker([{
        id: "long-session",
        workspace: "/work/a-very-long-workspace-name",
        session_path: "/sessions/long.jsonl",
        kind: "interactive",
        status: "idle",
        title: "This is a deliberately long first prompt title that must fit",
        updated_at: "2026-07-20T20:00:00.000Z",
    }], undefined, false, new Date("2026-07-20T21:00:00.000Z")));

    try {
        await setup.flush();
        const row = setup.captureCharFrame().split("\n").find(
            (line) => line.includes("This is a deliberately long"),
        );
        expect(row).toContain("1h ago · a-very-long-w…");
    } finally {
        setup.renderer.destroy();
    }
});

test("session title truncation keeps Unicode characters intact", () => {
    const state = startTuiSessionPicker([{
        id: "unicode",
        workspace: "/work/vera",
        session_path: "/sessions/unicode.jsonl",
        kind: "interactive",
        status: "idle",
        title: `${"a".repeat(28)}😀tail`,
        updated_at: "2026-07-20T20:00:00.000Z",
    }]);

    expect(state.options[0]?.label).toBe(`${"a".repeat(28)}😀…`);
    expect(state.options[0]?.label).not.toContain("�");
});

function session(
    id: string,
    status: "idle" | "working" | "failed" | "closed",
) {
    return {
        id,
        workspace: "/work/alpha",
        session_path: `/sessions/${id}.jsonl`,
        kind: "interactive" as const,
        status,
    };
}

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

test("model picker keeps the current model selected", async () => {
    const state = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );

    expect(state.options[state.selectedIndex]).toMatchObject({
        provider: "openrouter",
        model: "z-ai/glm-5.2",
    });
    const frame = await pickerFrame(state);
    expect(frame).toContain("Select model");
    // The provider is a group heading above its models, and the persisted
    // choice carries the current-dot.
    expect(frame).toMatch(/openrouter\s+\n/);
    expect(frame).toContain("● GLM-5.2");
    expect(frame).not.toContain("Recent");
});

test("model picker filters its choices as the user types", async () => {
    const state = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "max",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );
    const first = handleTuiSettingsPickerKey(state, { name: "g" });
    const second = handleTuiSettingsPickerKey(first.state ?? state, { name: "l" });

    expect(second.state?.query).toBe("gl");
    expect(second.state?.options.map((option) => option.model)).toEqual([
        "z-ai/glm-5.2",
    ]);
    // While searching, the flat result list carries its provider in the row's
    // right-hand column instead of a group heading.
    const frame = await pickerFrame(second.state ?? state);
    expect(frame).toContain("⌕  gl");
    expect(frame).toMatch(/GLM-5\.2\s+fast fallback model\s+openrouter/);
});

test("model picker distinguishes the same model id across providers", async () => {
    const models = [
        ...availableModels,
        {
            provider: "ollama",
            model: "moonshotai/kimi-k3",
            label: "Kimi K3 local",
            description: "local model",
        },
    ] as const;
    const state = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "off",
        "auto",
        models,
        "default",
        "ollama",
    );

    expect(state.options[state.selectedIndex]).toMatchObject({
        provider: "ollama",
        model: "moonshotai/kimi-k3",
    });
    expect(new Set(state.options.map((option) => option.value)).size)
        .toBe(state.options.length);
    expect(handleTuiSettingsPickerKey(state, { name: "enter" }).selection)
        .toEqual({
            kind: "model",
            provider: "ollama",
            model: "moonshotai/kimi-k3",
        });
    const rendered = await pickerFrame(state);
    expect(rendered).toMatch(/ollama\s+\n/);
    expect(rendered).toMatch(/openrouter\s+\n/);
});

test("every settings picker filters as the user types", async () => {
    const reasoning = startTuiReasoningPicker(REASONING_LEVELS, undefined, "high");
    const filteredReasoning = handleTuiSettingsPickerKey(reasoning, {
        name: "m",
    });
    expect(filteredReasoning.state?.options.map((option) => option.value))
        .toEqual(["max", "medium"]);

    const permissions = startTuiSettingsPicker(
        "permissions",
        "z-ai/glm-5.2",
        "high",
        "auto",
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
    expect(await pickerFrame(filteredPermissions)).toContain("⌕  full");
});

test("Kimi reasoning picker renders exactly the model's own levels", () => {
    const reasoning = startTuiReasoningPicker(
        [{ id: "max", label: "Max", description: "maximum available reasoning" }],
        undefined,
        "low",
    );
    const selected = handleTuiSettingsPickerKey(reasoning, { name: "enter" });
    expect(selected.selection).toEqual({
        kind: "reasoning",
        reasoningEffort: "max",
    });
    expect(reasoning.options.map((option) => option.value)).toEqual(["max"]);
});

test("GLM reasoning picker renders exactly the model's own levels", () => {
    const reasoning = startTuiReasoningPicker(
        [{ id: "max", label: "Max", description: "maximum available reasoning" }],
        undefined,
        "off",
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
        "auto",
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

test("permissions picker includes configured mode names", () => {
    const permissions = startTuiSettingsPicker(
        "permissions",
        "moonshotai/kimi-k3",
        "max",
        "unattended",
        undefined,
        undefined,
        undefined,
        ["ask", "auto", "full_access", "unattended"],
    );

    expect(permissions.options.map((option) => option.value)).toEqual([
        "ask",
        "auto",
        "full_access",
        "unattended",
    ]);
    expect(permissions.options.at(-1)).toMatchObject({
        label: "unattended",
        description: "custom permission mode",
    });
});

test("escape closes the settings picker", () => {
    const state = startTuiReasoningPicker(REASONING_LEVELS, undefined, "max");

    expect(handleTuiSettingsPickerKey(state, { name: "escape" })).toEqual({
        handled: true,
    });
});

test("escape inside a chained level pane steps back to the model pane instead of closing", () => {
    const modelPane = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "max",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );
    const levelPane = startTuiReasoningPicker(REASONING_LEVELS, undefined, "max", {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        modelPaneState: modelPane,
    });

    const back = handleTuiSettingsPickerKey(levelPane, { name: "escape" });
    expect(back.handled).toBe(true);
    expect(back.state).toBe(modelPane);
});

test("enter on a chained level pane folds the level into the model selection", () => {
    const modelPane = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "max",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );
    const levelPane = startTuiReasoningPicker(REASONING_LEVELS, undefined, "low", {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        modelPaneState: modelPane,
    });

    // "low" pre-highlights because it is the current effort and is valid for
    // this model's levels, matching `inferReasoningSelection`'s placement rule.
    expect(levelPane.options[levelPane.selectedIndex]?.value).toBe("low");
    expect(handleTuiSettingsPickerKey(levelPane, { name: "enter" }).selection)
        .toEqual({
            kind: "model",
            provider: "openrouter",
            model: "z-ai/glm-5.2",
            reasoningEffort: "low",
        });
});

test("level pane pre-highlight falls back to the model's default level, then a moderate one", () => {
    const withDefault = startTuiReasoningPicker(REASONING_LEVELS, "medium", "off");
    expect(withDefault.options[withDefault.selectedIndex]?.value).toBe("medium");

    // Never "max": an unplaceable level does not arrive pre-highlighted on the
    // most expensive row the model offers.
    const withoutDefault = startTuiReasoningPicker(REASONING_LEVELS, undefined, "off");
    expect(withoutDefault.options[withoutDefault.selectedIndex]?.value).toBe("medium");
});

test("the settings menu routes into permissions and its two entries", () => {
    const settings = startTuiSettingsMenu("settings");

    expect(settings.options.map((option) => option.value)).toEqual([
        "model",
        "reasoning",
        "permissions",
        "theme",
    ]);
    let permissions = settings;
    for (const name of "perm") {
        permissions = handleTuiSettingsPickerKey(permissions, { name }).state
            ?? permissions;
    }
    expect(handleTuiSettingsPickerKey(permissions, { name: "enter" }).selection)
        .toEqual({ kind: "menu", target: "permissions" });

    const permissionSettings = startTuiSettingsMenu("permission_settings");
    expect(permissionSettings.options.map((option) => option.value)).toEqual([
        "permission_mode",
        "granted_permissions",
    ]);
    const granted = handleTuiSettingsPickerKey(
        permissionSettings,
        { name: "down" },
    ).state ?? permissionSettings;
    expect(handleTuiSettingsPickerKey(granted, { name: "enter" }).selection)
        .toEqual({ kind: "menu", target: "granted_permissions" });
});

test("escape inside a settings submenu steps back to its parent", () => {
    // A wrong turn costs one key rather than a reopen of /settings.
    const back = handleTuiSettingsPickerKey(
        startTuiSettingsMenu("permission_settings"),
        { name: "escape" },
    );

    expect(back.handled).toBe(true);
    expect(back.state?.kind).toBe("settings");
    expect(handleTuiSettingsPickerKey(
        back.state ?? startTuiSettingsMenu("settings"),
        { name: "escape" },
    )).toEqual({ handled: true });
});

test("extension picker renders its title, stable rows, and semantic action footer", async () => {
    const state = startTuiExtensionPicker(
        "Model presets",
        [
            { id: "fast", label: "Fast", description: "quick model" },
            { id: "deep", label: "Deep", description: "reasoning model" },
        ],
        "deep",
        [
            { id: "apply", key: "enter", label: "apply" },
            { id: "save", key: "s", label: "save" },
            { id: "clear-delete", key: "delete", label: "clear" },
            { id: "clear-backspace", key: "backspace", label: "clear" },
        ],
    );

    expect(state.kind).toBe("extension");
    expect(state.title).toBe("Model presets");
    expect(state.extensionRows?.map((row) => row.id)).toEqual([
        "fast",
        "deep",
    ]);
    expect(state.selectedId).toBe("deep");
    expect(state.selectedIndex).toBe(1);

    const frame = await pickerFrame(state);
    expect(frame).toContain("Model presets");
    expect(frame).toContain("Fast");
    expect(frame).toContain("Deep");
    expect(frame).toContain("⏎ apply");
    expect(frame).toContain("s save");
    expect(frame).toContain("del clear");
    expect(frame).toContain("⌫ clear");
    expect(frame).not.toContain("Search");
});

test("extension picker returns row IDs and action IDs for every semantic binding", () => {
    const state = startTuiExtensionPicker(
        "Actions",
        [
            { id: "first", label: "First" },
            { id: "second", label: "Second" },
        ],
        "first",
        [
            { id: "apply", key: "enter", label: "apply" },
            { id: "save", key: "s", label: "save" },
            { id: "delete", key: "delete", label: "delete" },
            { id: "backspace", key: "backspace", label: "backspace" },
        ],
    );

    const moved = handleTuiSettingsPickerKey(state, { name: "down" });
    expect(moved.state?.selectedId).toBe("second");
    expect(moved.state?.options[moved.state.selectedIndex]?.value)
        .toBe("second");

    const selected = moved.state ?? state;
    expect(handleTuiSettingsPickerKey(selected, { name: "enter" }).selection)
        .toEqual({ kind: "extension", rowId: "second", actionId: "apply" });
    expect(handleTuiSettingsPickerKey(selected, { name: "s" }).selection)
        .toEqual({ kind: "extension", rowId: "second", actionId: "save" });
    expect(handleTuiSettingsPickerKey(selected, { name: "delete" }).selection)
        .toEqual({ kind: "extension", rowId: "second", actionId: "delete" });
    expect(handleTuiSettingsPickerKey(selected, { name: "backspace" }).selection)
        .toEqual({
            kind: "extension",
            rowId: "second",
            actionId: "backspace",
        });
});

test("theme picker is curated, searchable, and keeps the current theme selected", () => {
    const themes = startTuiSettingsPicker(
        "theme",
        undefined,
        undefined,
        undefined,
        undefined,
        "nightowl",
    );

    expect(themes.options.map((option) => option.value)).toEqual([
        "default",
        "system",
        "orng",
        "palenight",
        "synthwave",
        "nightowl",
        "github",
    ]);
    expect(themes.options[themes.selectedIndex]?.value).toBe("nightowl");
    let filtered = themes;
    for (const name of "owl") {
        filtered = handleTuiSettingsPickerKey(filtered, { name }).state
            ?? filtered;
    }
    expect(filtered.options.map((option) => option.value)).toEqual([
        "nightowl",
    ]);
    expect(handleTuiSettingsPickerKey(themes, { name: "down" }).previewTheme)
        .toBe("github");
    expect(handleTuiSettingsPickerKey(themes, { name: "escape" }).previewTheme)
        .toBe("nightowl");
    expect(handleTuiSettingsPickerKey(filtered, { name: "backspace" }).previewTheme)
        .toBe("nightowl");
});

test("theme picker renders as a borderless palette card with swatches", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const view = createTuiSettingsPickerView(setup.renderer);
    // Before the first update, so this cannot pass because `update()` reset it.
    // OpenTUI's BoxRenderable constructor overrides `border: false` when any
    // border styling option is also passed, which is what used to need resetting.
    expect(view.box.border).toBe(false);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(startTuiSettingsPicker(
        "theme",
        undefined,
        undefined,
        undefined,
        undefined,
        "default",
    ));

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Theme");
        expect(frame).toContain("esc");
        // Persisted theme carries the current-dot; every row shows a swatch.
        expect(frame).toContain("● Default");
        expect(frame).toContain("██ ██ ██ ██");
        // System is terminal-derived, so it shows a neutral placeholder swatch.
        expect(frame).toContain("░░ ░░ ░░ ░░");
        expect(frame).toContain("↑↓ move · ⏎ apply · esc cancel");
        expect(frame).not.toContain("┌");
        expect(view.box.border).toBe(false);
    } finally {
        setup.renderer.destroy();
    }
});
