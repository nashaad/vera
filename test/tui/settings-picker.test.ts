import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    handleTuiSettingsPickerKey,
    handleTuiSettingsPickerScroll,
    startTuiSettingsMenu,
    startTuiSettingsPicker,
    startTuiProviderPicker,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    createTuiSettingsPickerView,
    syncTuiModelPicker,
    tuiPickerMenuAncestor,
    withTuiPickerParent,
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

test("session picker filters titled durable conversations and selects an agent", async () => {
    const state = startTuiSessionPicker([
        {
            id: "11111111-first-session",
            workspace: "/work/alpha",
            session_path: "/sessions/first.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            title: "Fix the deployment race",
            updated_at: "2026-07-20T20:00:00.000Z",
        },
        {
            id: "22222222-background",
            workspace: "/work/beta",
            session_path: "/sessions/background.jsonl",
            kind: "background",
            status: "completed",
            live: false,
        },
    ], undefined, false, new Date("2026-07-20T21:00:00.000Z"));

    const frame = await pickerFrame(state);
    expect(frame).toContain("Fix the deployment race");
    expect(frame).toContain("1h ago");
    expect(frame).toContain("alpha");
    expect(frame).not.toContain("22222222");
    expect(handleTuiSettingsPickerKey(state, { name: "enter" }).selection)
        .toEqual({
            kind: "session",
            sessionPath: "/sessions/first.jsonl",
            // The id rides along so the caller can recognise the row for the
            // session already on screen and close instead of re-attaching.
            sessionId: "11111111-first-session",
        });
    expect(handleTuiSettingsPickerKey(
        state,
        { name: "delete" },
    ).trashCandidate).toEqual({
        sessionId: "11111111-first-session",
        label: "Fix the deployment race",
    });

    expect(handleTuiSettingsPickerKey(
        state,
        { name: "r", ctrl: true },
    ).renameCandidate).toEqual({
        sessionId: "11111111-first-session",
        label: "Fix the deployment race",
    });
    expect(frame).toContain("^r rename");

    let searched = state;
    for (const name of "11111111-first-session") {
        searched = handleTuiSettingsPickerKey(searched, { name }).state
            ?? searched;
    }
    expect(searched.options).toHaveLength(1);
});

test("session picker threads an async subagent under its parent", async () => {
    const state = startTuiSessionPicker([
        {
            id: "parent",
            workspace: "/work/vera",
            session_path: "/sessions/parent.jsonl",
            kind: "interactive",
            status: "idle",
            live: true,
            title: "Coordinate parser work",
            updated_at: "2026-07-20T20:00:00.000Z",
        },
        {
            id: "child",
            workspace: "/work/vera",
            session_path: "/sessions/child.jsonl",
            kind: "background",
            status: "working",
            live: true,
            title: "Audit both parsers",
            updated_at: "2026-07-20T20:01:00.000Z",
            parent_id: "parent",
        },
    ], "parent", false, new Date("2026-07-20T20:02:00.000Z"));

    expect(state.options.map((option) => option.sessionId))
        .toEqual(["parent", "child"]);
    expect(state.options[1]).toMatchObject({
        depth: 1,
        activity: "working",
        threadParent: "parent",
    });
    const frame = await pickerFrame(state);
    expect(frame).toContain("Coordinate parser work");
    expect(frame).toContain("Audit both parsers");
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
    expect(rendered).toContain("working");
    expect(rendered).toContain("alpha");
});

test("an open session says so where a stopped one says how long ago", async () => {
    const state = startTuiSessionPicker([
        {
            ...session("open", "idle"),
            live: true,
            title: "Being read right now",
            updated_at: "2026-07-20T18:00:00.000Z",
        },
        {
            ...session("stopped", "idle"),
            title: "Left alone since yesterday",
            updated_at: "2026-07-20T18:00:00.000Z",
        },
    ], undefined, false, new Date("2026-07-20T21:00:00.000Z"));

    const rows = (await pickerFrame(state)).split("\n");
    const rowFor = (title: string): string =>
        rows.find((line) => line.includes(title)) ?? "";
    // Same timestamp on both rows, so the difference on screen is liveness
    // and nothing else.
    expect(rowFor("Being read right now")).toContain("open");
    expect(rowFor("Left alone since yesterday")).toContain("3h");
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
        live: false,
        title: "This is a deliberately long first prompt title that must fit",
        updated_at: "2026-07-20T20:00:00.000Z",
    }], undefined, false, new Date("2026-07-20T21:00:00.000Z")));

    try {
        await setup.flush();
        const row = setup.captureCharFrame().split("\n").find(
            (line) => line.includes("This is a deliberately long"),
        );
        // The title runs from the time column to the workspace column rather
        // than stopping at a fixed measure well short of the terminal edge.
        expect(row).toContain("1h ago");
        expect(row).toContain("a-very-long-w…");
        expect(row).toContain("deliberately long first prompt title");
        expect(row?.length).toBe(80);
    } finally {
        setup.renderer.destroy();
    }
});

test("session titles reach the picker whole", () => {
    const state = startTuiSessionPicker([{
        id: "unicode",
        workspace: "/work/vera",
        session_path: "/sessions/unicode.jsonl",
        kind: "interactive",
        status: "idle",
        live: false,
        title: `${"a".repeat(28)}😀tail`,
        updated_at: "2026-07-20T20:00:00.000Z",
    }]);

    // Titles are no longer cut to a fixed measure: the row clips at whatever
    // the terminal actually has, so the option keeps the whole title.
    expect(state.options[0]?.label).toBe(`${"a".repeat(28)}😀tail`);
    expect(state.options[0]?.label).not.toContain("�");
});

test("session columns are bounded in cells, not characters", () => {
    const state = startTuiSessionPicker([{
        id: "wide",
        // Fourteen characters, twenty-eight terminal cells. The workspace
        // column does not shrink, so measuring it in characters would push the
        // row past the terminal edge.
        workspace: `/work/${"界".repeat(14)}`,
        session_path: "/sessions/wide.jsonl",
        kind: "interactive",
        status: "idle",
        live: false,
        title: "x".repeat(400),
        updated_at: "2026-07-20T20:00:00.000Z",
    }]);

    const option = state.options[0]!;
    expect(Bun.stringWidth(option.workspace ?? "")).toBeLessThanOrEqual(14);
    expect([...option.label]).toHaveLength(200);
    expect(option.label.endsWith("…")).toBe(true);
});

test("session forks hang under the session they came from", async () => {
    const base = {
        workspace: "/work/vera",
        kind: "interactive" as const,
        status: "idle" as const,
        live: false,
    };
    const state = startTuiSessionPicker([
        {
            ...base,
            id: "parent",
            session_path: "/sessions/parent.jsonl",
            title: "lets talk about cooking",
            updated_at: "2026-07-20T19:00:00.000Z",
        },
        {
            ...base,
            id: "child",
            session_path: "/sessions/child.jsonl",
            title: "cooking, but vegetarian",
            updated_at: "2026-07-20T20:30:00.000Z",
            forked_from: "parent",
        },
        {
            ...base,
            id: "orphan",
            session_path: "/sessions/orphan.jsonl",
            title: "forked from a trashed session",
            updated_at: "2026-07-20T20:45:00.000Z",
            forked_from: "gone",
        },
    ], undefined, false, new Date("2026-07-20T21:00:00.000Z"));

    // The fork moves next to its parent even though it is the more recent of
    // the two; a fork of a session that is not listed stays where it sorted.
    expect(state.options.map((option) => option.sessionId))
        .toEqual(["orphan", "parent", "child"]);
    expect(state.options[2]?.depth).toBe(1);
    expect(state.options[0]?.depth).toBeUndefined();

    const frame = await pickerFrame(state);
    const rows = frame.split("\n");
    const child = rows.find((row) => row.includes("but vegetarian"));
    const orphan = rows.find((row) => row.includes("a trashed session"));
    expect(child).toContain("└");
    expect(orphan).not.toContain("└");
    // The fork's title starts right of its parent's, which is the indent.
    const parent = rows.find((row) => row.includes("talk about cooking"))!;
    expect(child!.indexOf("cooking, but"))
        .toBeGreaterThan(parent.indexOf("lets talk"));
});

test("a fork loses its thread when search hides the parent", async () => {
    const base = {
        workspace: "/work/vera",
        kind: "interactive" as const,
        status: "idle" as const,
        live: false,
        updated_at: "2026-07-20T20:00:00.000Z",
    };
    let state = startTuiSessionPicker([
        {
            ...base,
            id: "parent",
            session_path: "/sessions/parent.jsonl",
            title: "cooking",
        },
        {
            ...base,
            id: "child",
            session_path: "/sessions/child.jsonl",
            title: "cheese omelette",
            forked_from: "parent",
        },
        {
            ...base,
            id: "unrelated",
            session_path: "/sessions/unrelated.jsonl",
            title: "cheese shopping",
        },
    ]);

    for (const name of "cheese") {
        state = handleTuiSettingsPickerKey(state, { name }).state ?? state;
    }
    expect(state.options.map((option) => option.sessionId))
        .toEqual(["child", "unrelated"]);
    // Without the parent on screen the fork is its own row, not something
    // hanging off whichever match search happened to leave above it.
    expect(await pickerFrame(state)).not.toContain("└");
});

test("a cycle in reported parentage still lists every session", () => {
    const base = {
        workspace: "/work/vera",
        kind: "interactive" as const,
        status: "idle" as const,
        live: false,
        updated_at: "2026-07-20T20:00:00.000Z",
    };
    const state = startTuiSessionPicker([
        {
            ...base,
            id: "a",
            session_path: "/sessions/a.jsonl",
            title: "first",
            forked_from: "b",
        },
        {
            ...base,
            id: "b",
            session_path: "/sessions/b.jsonl",
            title: "second",
            forked_from: "a",
        },
    ]);

    expect(state.options.map((option) => option.sessionId).toSorted())
        .toEqual(["a", "b"]);
});

test("a long fork chain threads without exhausting the stack", () => {
    const state = startTuiSessionPicker(
        Array.from({ length: 40_000 }, (_value, index) => ({
            workspace: "/work/vera",
            kind: "interactive" as const,
            status: "idle" as const,
            live: false,
            updated_at: "2026-07-20T20:00:00.000Z",
            id: `s${index}`,
            session_path: `/sessions/s${index}.jsonl`,
            title: `session ${index}`,
            ...(index === 0 ? {} : { forked_from: `s${index - 1}` }),
        })),
    );

    expect(state.options).toHaveLength(40_000);
    expect(state.options[0]?.sessionId).toBe("s0");
    expect(state.options[1]?.depth).toBe(1);
    expect(state.options.at(-1)?.depth).toBe(39_999);
});

test("a duplicated session id keeps both rows on the list", () => {
    const base = {
        workspace: "/work/vera",
        kind: "interactive" as const,
        status: "idle" as const,
        live: false,
        updated_at: "2026-07-20T20:00:00.000Z",
        title: "same id",
    };
    const state = startTuiSessionPicker([
        { ...base, id: "dup", session_path: "/sessions/one.jsonl" },
        { ...base, id: "dup", session_path: "/sessions/two.jsonl" },
        {
            ...base,
            id: "child",
            session_path: "/sessions/child.jsonl",
            forked_from: "dup",
        },
    ]);

    // A host reporting one id twice is a host bug, but dropping a session over
    // it would hide work the user can still open.
    expect(state.options.map((option) => option.value)).toContain(
        "/sessions/one.jsonl",
    );
    expect(state.options.map((option) => option.value)).toContain(
        "/sessions/two.jsonl",
    );
    expect(state.options).toHaveLength(3);
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
        live: status === "working",
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
    // A search result is still in provider order, so it keeps the headings
    // rather than repeating the provider on each row.
    const frame = await pickerFrame(second.state ?? state);
    expect(frame).toContain("⌕  gl");
    expect(frame).toMatch(/openrouter\s+GLM-5\.2/);
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

test("escape steps back to the pane a pane was opened from", () => {
    // A wrong turn costs one key rather than a reopen of /settings, and it
    // lands on the menu the user actually left, cursor and all, rather than a
    // fresh one built to look like it.
    const menu = handleTuiSettingsPickerKey(
        startTuiSettingsMenu("settings"),
        { name: "down" },
    ).state!;
    const submenu = withTuiPickerParent(
        startTuiSettingsMenu("permission_settings"),
        menu,
    );

    const back = handleTuiSettingsPickerKey(submenu, { name: "escape" });

    expect(back.handled).toBe(true);
    expect(back.state).toBe(menu);
    // The menu itself was opened by a slash command, so there is nothing under
    // it and escape closes.
    expect(handleTuiSettingsPickerKey(menu, { name: "escape" }))
        .toEqual({ handled: true });
});

test("a finished choice returns to the menu, not to the pane it just answered", () => {
    const menu = startTuiSettingsMenu("settings");
    const theme = withTuiPickerParent(
        startTuiSettingsPicker("theme", undefined, undefined, undefined),
        menu,
    );
    const chained = startTuiReasoningPicker(
        [{ id: "high", label: "High" }],
        undefined,
        undefined,
        {
            provider: "openai-codex",
            model: "gpt-5.2-codex",
            modelPaneState: withTuiPickerParent(
                startTuiSettingsPicker("model", undefined, undefined, undefined),
                menu,
            ),
        },
    );

    expect(tuiPickerMenuAncestor(theme)).toBe(menu);
    // Two levels down: the level pane folds into the model pane, and neither is
    // still a question once a model has been chosen.
    expect(tuiPickerMenuAncestor(chained)).toBe(menu);
    expect(tuiPickerMenuAncestor(menu)).toBeUndefined();
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
        "Switching models may make the next turn slower.",
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
    expect(frame).toContain("Switching models may make the next turn slower.");
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

const pinnedModels = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        available: true,
        description: "frontier coding model",
        levels: [],
    },
    {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        available: false,
        levels: [],
    },
] as const;

function modelPickerWithPins(
    pinned: readonly (typeof pinnedModels)[number][] = pinnedModels,
) {
    return startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "max",
        "auto",
        availableModels,
        "default",
        "openrouter",
        undefined,
        pinned,
    );
}

test("the model pane opens on Pinned, in the order the user's own use produced", async () => {
    const state = modelPickerWithPins();
    const frame = await pickerFrame(state);

    expect(state.tab).toBe("pinned");
    // Pin order, not provider order: the pin list is ordered by when each model
    // was pinned, and sorting it by provider would throw that away.
    expect(state.options.map((option) => option.model)).toEqual([
        "gpt-5.6-sol",
        "z-ai/glm-5.2",
    ]);
    // An entry that cannot run right now stays in the list: the user put it
    // there, so only the user takes it out. It says so in the column that would
    // otherwise carry its provider, since that is the one fact about the row a
    // heading could never carry.
    expect(frame).toContain("unavailable");
    expect(frame).toContain("All models");
    expect(frame).toContain("Pinned");
});

test("with nothing pinned the pane opens on All models", () => {
    // An empty tab answers no question, so the pane falls back to the list that
    // can always answer "which model do I switch to".
    expect(modelPickerWithPins([]).tab).toBe("all");
});

test("⇥ moves to All models, which lists what can run", async () => {
    const state = modelPickerWithPins();
    const allTab = handleTuiSettingsPickerKey(state, { name: "tab" }).state;

    expect(allTab?.tab).toBe("all");
    // A pinned model that cannot run right now is not offered here: choosing it
    // would be a dead end. It keeps its row on the Pinned tab.
    expect(allTab?.options.map((option) => option.model)).toEqual([
        "z-ai/glm-5.2",
        "moonshotai/kimi-k3",
    ]);
    expect(await pickerFrame(allTab!)).not.toContain("not available right now");

    // And back, since with two tabs one key is enough for both directions.
    expect(handleTuiSettingsPickerKey(allTab!, { name: "tab" }).state?.tab)
        .toBe("pinned");
});

test("no model appears twice, because a pin is a mark on its own row", () => {
    const state = modelPickerWithPins();

    expect(state.allOptions.filter((option) =>
        option.model === "z-ai/glm-5.2"
    )).toHaveLength(1);
    // The same row carries the pin and answers on both tabs.
    const glm = state.allOptions.find((option) =>
        option.model === "z-ai/glm-5.2"
    );
    expect(glm?.pinnedRank).toBe(1);
});

test("a model row is the name alone, with no description beside it", async () => {
    const long = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "high",
        "auto",
        [{
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
            label: "Kimi K3",
            description:
                "a description long enough to run the whole way across the card "
                + "and into the column beside it",
        }],
        "default",
        "openrouter",
    );
    // A model's blurb is not what anyone picks on, and at card widths it only
    // ever arrived clipped to a few characters, so the row is the name and the
    // provider heading above it.
    const searched = handleTuiSettingsPickerKey(long, { name: "k" }).state!;
    const frame = await pickerFrame(searched);

    expect(frame).toContain("Kimi K3");
    expect(frame).not.toContain("a description long enough");
    expect(frame).not.toContain("…");
});

test("a search reaches models on the other tab", () => {
    const onPinned = modelPickerWithPins();
    const searched = handleTuiSettingsPickerKey(onPinned, { name: "k" });

    // kimi is runnable but not pinned, so it has no row on this tab. Typing its
    // name still finds it: the user is asking whether the model exists, not
    // whether it exists on the tab they happen to be standing on.
    expect(searched.state?.options.map((option) => option.model))
        .toContain("moonshotai/kimi-k3");
    expect(searched.state?.options.filter((option) =>
        option.model === "moonshotai/kimi-k3"
    )).toHaveLength(1);

    // Clearing the query drops back to the tab's own list.
    const cleared = handleTuiSettingsPickerKey(
        searched.state!,
        { name: "backspace" },
    );
    expect(cleared.state?.options.map((option) => option.model)).toEqual([
        "gpt-5.6-sol",
        "z-ai/glm-5.2",
    ]);
});

test("ctrl+s asks to pinned the highlighted model, and to unpin a pinned one", () => {
    const state = modelPickerWithPins([]);
    const kimi = handleTuiSettingsPickerKey(state, { name: "s", ctrl: true });

    expect(kimi.pinToggle).toEqual({
        action: "add",
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
    });
    // The pane does not edit its own list: the row is unchanged until the host
    // answers with a new snapshot.
    expect(kimi.state).toBe(state);

    // The pane opens on Pinned, whose first row is the most recently used pin.
    const cursor = modelPickerWithPins();

    expect(cursor.options[cursor.selectedIndex]?.model).toBe("gpt-5.6-sol");
    expect(
        handleTuiSettingsPickerKey(cursor, { name: "s", ctrl: true })
            .pinToggle,
    ).toEqual({
        action: "remove",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
    });
});

test("the model picker footer names the action the highlighted row would take", async () => {
    const onPinnedRow = modelPickerWithPins();
    expect(onPinnedRow.options[onPinnedRow.selectedIndex]?.model)
        .toBe("gpt-5.6-sol");
    expect(await pickerFrame(onPinnedRow)).toContain("^s unpin");

    const onRunningModel = handleTuiSettingsPickerKey(
        onPinnedRow,
        { name: "tab" },
    ).state!;
    expect(onRunningModel.options[onRunningModel.selectedIndex]?.model)
        .toBe("moonshotai/kimi-k3");
    expect(await pickerFrame(onRunningModel)).toContain("^s pin");
});

test("a settings snapshot rebuilds the open pane without moving the cursor", () => {
    const state = modelPickerWithPins([]);
    const highlighted = state.options[state.selectedIndex];
    const synced = syncTuiModelPicker(state, {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        availableModels,
        pinned: pinnedModels,
    });

    // A row gained a pin mark above the cursor. The cursor follows the model,
    // not the index.
    expect(synced.options[synced.selectedIndex]?.value)
        .toBe(highlighted?.value);
    expect(synced.allOptions.find((option) =>
        option.model === "z-ai/glm-5.2"
    )?.pinnedRank).toBe(1);
});

test("a snapshot leaves the user on the tab they moved to", () => {
    // The tab is the user's own place in the pane, so a rebuild must not drop
    // them back onto the one it opens with mid-action.
    const onAllTab = handleTuiSettingsPickerKey(
        modelPickerWithPins(),
        { name: "tab" },
    ).state!;
    const synced = syncTuiModelPicker(onAllTab, {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        availableModels,
        pinned: pinnedModels,
    });

    expect(synced.tab).toBe("all");
    expect(synced.options.map((option) => option.model)).toEqual([
        "z-ai/glm-5.2",
        "moonshotai/kimi-k3",
    ]);
});

test("a snapshot keeps the pane the pane was opened from", () => {
    // Pinning a model round-trips through the host and rebuilds this pane. If
    // the rebuild dropped the parent, pinning would quietly turn escape from
    // "back to /settings" into "close everything".
    const menu = startTuiSettingsMenu("settings");
    const state = withTuiPickerParent(modelPickerWithPins([]), menu);
    const synced = syncTuiModelPicker(state, {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        availableModels,
        pinned: pinnedModels,
    });

    expect(handleTuiSettingsPickerKey(synced, { name: "escape" }).state)
        .toBe(menu);
    expect(tuiPickerMenuAncestor(synced)).toBe(menu);
});

const PROVIDER_ROWS = [
    {
        id: "openai-codex",
        label: "OpenAI Codex",
        group: "Popular",
        hint: "ChatGPT Plus/Pro subscription",
        connected: true,
    },
    {
        id: "openrouter",
        label: "OpenRouter",
        group: "Popular",
        hint: "API key, pay per token",
        connected: false,
    },
    {
        id: "ollama",
        label: "Ollama",
        group: "Providers",
        hint: "local, no account",
        connected: true,
    },
] as const;

test("the connect pane groups providers, marks the connected ones, and says what each wants", async () => {
    const frame = await pickerFrame(startTuiProviderPicker(PROVIDER_ROWS));

    expect(frame).toContain("Connect a provider");
    expect(frame).toContain("Popular");
    expect(frame).toContain("Providers");
    // The mark is a check rather than the dot the other panes use: several
    // providers can be connected at once, so it is not a "currently in effect".
    expect(frame).toMatch(/✓\s+OpenAI Codex/);
    expect(frame).toMatch(/✓\s+Ollama/);
    expect(frame).not.toMatch(/✓\s+OpenRouter/);
    // The credential is on the row, so choosing one is not a surprise about
    // what it is going to ask for.
    expect(frame).toContain("ChatGPT Plus/Pro subscription");
    expect(frame).toContain("API key, pay per token");
});

test("the connect pane opens on the first provider still to be connected", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);

    expect(pane.options[pane.selectedIndex]?.value).toBe("openrouter");
    expect(handleTuiSettingsPickerKey(pane, { name: "enter" }).selection)
        .toEqual({ kind: "provider", providerId: "openrouter" });
});

test("ctrl+e asks for the connect pane instead of building it", () => {
    // Which providers are connected is a fact about the disk, so the pane
    // reports the request and the client that can read it answers.
    const model = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        undefined,
        undefined,
        availableModels,
        undefined,
        "openrouter",
    );

    const transition = handleTuiSettingsPickerKey(model, {
        name: "e",
        ctrl: true,
    });

    expect(transition.handled).toBe(true);
    expect(transition.openProviders).toBe(true);
    expect(transition.state).toBe(model);
    expect(transition.selection).toBeUndefined();
});

test("escape from the connect pane returns to the model pane it was opened over", () => {
    const model = startTuiSettingsPicker("model", undefined, undefined, undefined);
    const providers = withTuiPickerParent(
        startTuiProviderPicker(PROVIDER_ROWS),
        model,
    );

    expect(handleTuiSettingsPickerKey(providers, { name: "escape" }).state)
        .toBe(model);
});

test("the wheel moves the cursor, so enter still means the row on screen", () => {
    // The pane windows itself around selectedIndex. A wheel that slid the
    // window on its own would leave the highlight off screen, pointing at
    // something the user can no longer see.
    const state = modelPickerWithPins();
    const down = handleTuiSettingsPickerScroll(state, {
        direction: "down",
        delta: 3,
    });

    expect(down.handled).toBe(true);
    expect(down.state?.selectedIndex).toBe(
        Math.min(3, state.options.length - 1),
    );
    expect(handleTuiSettingsPickerScroll(down.state!, {
        direction: "up",
        delta: 3,
    }).state?.selectedIndex).toBe(state.selectedIndex);
});

test("the wheel stops at both ends and ignores a sideways scroll", () => {
    const state = modelPickerWithPins();

    expect(handleTuiSettingsPickerScroll(state, {
        direction: "up",
        delta: 40,
    }).state?.selectedIndex).toBe(0);
    expect(handleTuiSettingsPickerScroll(state, {
        direction: "down",
        delta: 400,
    }).state?.selectedIndex).toBe(state.options.length - 1);
    expect(handleTuiSettingsPickerScroll(state, {
        direction: "left",
        delta: 3,
    }).handled).toBe(false);
});

test("a trackpad delta below one row still moves a row", () => {
    // A scroll that moves nothing reads as a dead pane.
    expect(handleTuiSettingsPickerScroll(modelPickerWithPins(), {
        direction: "down",
        delta: 0.2,
    }).state?.selectedIndex).toBe(1);
});

test("the pane names the half-page keys where it names the others", async () => {
    // ctrl+d and ctrl+u are unfindable otherwise: nothing on screen says a
    // pane responds to them.
    expect(await pickerFrame(modelPickerWithPins())).toContain("^d^u move");
});
