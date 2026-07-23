import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    handleTuiSettingsPickerKey,
    startTuiSettingsPicker,
    startTuiSessionPicker,
    createTuiSettingsPickerView,
    type TuiSettingsPickerState,
} from "../../clients/tui/settings-picker.ts";

// The pickers render as renderable rows, so their look is asserted against a
// captured frame rather than a string projection of the same state.
async function pickerFrame(
    state: TuiSettingsPickerState,
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
        "approve_for_me",
        undefined,
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
        "approve_for_me",
        undefined,
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
        "approve_for_me",
        undefined,
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
    expect(await pickerFrame(filteredPermissions)).toContain("⌕  full");
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

test("theme picker is curated, searchable, and keeps the current theme selected", () => {
    const themes = startTuiSettingsPicker(
        "theme",
        undefined,
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
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(startTuiSettingsPicker(
        "theme",
        undefined,
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
