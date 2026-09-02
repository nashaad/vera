import type { PooledModel } from "../../src/model/catalog-view.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable, type StyledText } from "@opentui/core";

import { tuiKeyHint } from "../../clients/tui/keymap.ts";
import { applyTuiTheme } from "../../clients/tui/state.ts";
import { resolveTuiTheme, VERA_TUI_THEME } from "../../clients/tui/theme.ts";

import {
    handleTuiSettingsPickerKey,
    handleTuiSettingsPickerScroll,
    startTuiConfigurePicker,
    startTuiSettingsMenu,
    startTuiContextLimitPicker,
    startTuiDeveloperMenu,
    startTuiDeveloperValuePicker,
    startTuiSettingsPicker,
    switchedModelTab,
    tuiModelActionOptions,
    startTuiProviderPicker,
    TUI_DECLARE_PROVIDER_VALUE,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    createTuiSettingsPickerView,
    updateTuiSettingsPickerSearch,
    tuiProviderGroup,
    mergeTuiModelPickerSettings,
    moveTuiSettingsPickerPointer,
    syncTuiModelPicker,
    pickerFooter,
    tuiPickerAfterSelection,
    tuiPickerViewportRows,
    tuiPickerMenuAncestor,
    withTuiPickerParent,
    type TuiAnySettingsPickerState,
    type TuiSettingsPickerOption,
    type TuiSettingsPickerState,
    startTuiReviewerMenu,
    startTuiReviewerPicker,
    REVIEWER_CLEAR_VALUE,
    handleTuiProviderFormKey,
    handleTuiProviderFormPaste,
    createTuiProviderFormView,
    startTuiProviderForm,
    tuiProviderFormFields,
    tuiProviderFormRows,
    type TuiProviderFormState,
    startTuiCatalogRefreshScopePicker,
    startTuiPoolVerifyScopePicker,
    MODEL_ASSIGNMENT_BROWSE_VALUE,
    MODEL_ASSIGNMENT_SELF_VALUE,
    startTuiModelAssignmentPicker,
    tuiModelAssignmentOptions,
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
    tip?: string,
): Promise<string> {
    const setup = await createTestRenderer({ width, height });
    const view = createTuiSettingsPickerView(setup.renderer);
    view.tip = tip;
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

test("inset pickers sit on the screen's top padding row", async () => {
    const { renderer } = await createTestRenderer({ width: 100, height: 40 });
    try {
        const view = createTuiSettingsPickerView(renderer);
        view.update(startTuiSettingsPicker(
            "model",
            undefined,
            undefined,
            "auto",
            availableModels,
            "default",
        ));
        expect(view.box.top).toBe(1);

        view.update(startTuiSessionPicker([], undefined, false));
        expect(view.box.top).toBe(0);
    } finally {
        renderer.destroy();
    }
});

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
            sourceDisposition: "stop",
        });
    expect(handleTuiSettingsPickerKey(state, { name: "tab" }).selection)
        .toEqual({
            kind: "session",
            sessionPath: "/sessions/first.jsonl",
            sessionId: "11111111-first-session",
            sourceDisposition: "keep_running",
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
        value: "Fix the deployment race",
    });
    expect(frame).toContain("^r rename");
    expect(frame).toContain("⏎ stop & switch");
    expect(frame).toContain("tab keep running");

    const searched = updateTuiSettingsPickerSearch(
        state,
        "11111111-first-session",
    ).state!;
    expect(searched.options).toHaveLength(1);
});

test("session search accepts spaces between words", () => {
    const start = startTuiSessionPicker([{
        id: "11111111-first-session",
        workspace: "/work/alpha",
        session_path: "/sessions/first.jsonl",
        kind: "interactive",
        status: "idle",
        live: false,
        title: "Turn planning",
    }]);
    const state = updateTuiSettingsPickerSearch(start, "turn p").state!;
    expect(state.query).toBe("turn p");
    expect(state.options).toHaveLength(1);
});

test("a child picker can include an untitled hosted agent", async () => {
    const state = startTuiSessionPicker([{
        id: "frosty-frost:9f3a:UAT-tester",
        workspace: "/work/alpha",
        session_path: "/sessions/child.jsonl",
        kind: "background",
        status: "working",
        live: true,
        parent_id: "parent",
    }], "parent", false, new Date(), true);

    expect(await pickerFrame(state)).toContain("frosty-frost:9f3a:UAT-tester");
    expect(handleTuiSettingsPickerKey(state, { name: "enter" }).selection)
        .toEqual({
            kind: "session",
            sessionPath: "/sessions/child.jsonl",
            sessionId: "frosty-frost:9f3a:UAT-tester",
            sourceDisposition: "stop",
        });
});

test("a child picker Enter keeps the source running", async () => {
    const state = startTuiSessionPicker(
        [{
            id: "frosty-frost:9f3a:UAT-tester",
            workspace: "/work/alpha",
            session_path: "/sessions/child.jsonl",
            kind: "background",
            status: "working",
            live: true,
            parent_id: "parent",
        }],
        "parent",
        false,
        new Date(),
        true,
        [],
        "keep_running",
    );

    expect(handleTuiSettingsPickerKey(state, { name: "enter" }).selection)
        .toEqual({
            kind: "session",
            sessionPath: "/sessions/child.jsonl",
            sessionId: "frosty-frost:9f3a:UAT-tester",
            sourceDisposition: "keep_running",
        });
    const frame = await pickerFrame(state);
    expect(frame).toContain("⏎ switch");
    expect(frame).not.toContain("stop & switch");
    expect(frame).not.toContain("keep running");
});

test("opened from home, Enter just opens the conversation", async () => {
    const state = startTuiSessionPicker(
        [{
            id: "frosty-frost:9f3a:UAT-tester",
            workspace: "/work/alpha",
            session_path: "/sessions/one.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            title: "a conversation",
        }],
        undefined,
        false,
        new Date(),
        false,
        [],
        "stop",
        true,
    );

    const frame = await pickerFrame(state);
    expect(frame).toContain("⏎ open");
    expect(frame).not.toContain("stop & switch");
    expect(frame).not.toContain("keep running");
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

test("the two visible panes form a shared group without implying ancestry", async () => {
    const state = startTuiSessionPicker([
        {
            ...session("main", "idle"),
            live: true,
            title: "Main conversation",
            updated_at: "2026-07-20T20:00:00.000Z",
        },
        {
            ...session("unrelated", "idle"),
            title: "Unrelated conversation",
            updated_at: "2026-07-20T19:30:00.000Z",
        },
        {
            ...session("attached", "idle"),
            live: true,
            title: "Attached conversation",
            updated_at: "2026-07-20T19:00:00.000Z",
        },
    ], "main", false, new Date("2026-07-20T21:00:00.000Z"), false, [[
        "main",
        "attached",
    ]]);

    const rows = (await pickerFrame(state)).split("\n");
    const main = rows.find((row) => row.includes("Main conversation")) ?? "";
    const attached = rows.find((row) =>
        row.includes("Attached conversation")
    ) ?? "";
    const unrelated = rows.find((row) =>
        row.includes("Unrelated conversation")
    ) ?? "";
    expect(main).toContain("┌ open");
    expect(attached).toContain("└ open");
    expect(unrelated).not.toMatch(/[┌└]/);
    expect(state.options.map((option) => option.sessionId)).toEqual([
        "main",
        "attached",
        "unrelated",
    ]);
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
    const start = startTuiSessionPicker([
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

    const state = updateTuiSettingsPickerSearch(start, "cheese").state!;
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
        refreshable: true,
    },
    {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "Z-AI: GLM-5.2",
        description: "fast fallback model",
        refreshable: true,
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
    // choice carries the current-dot. The dot hangs in the card's padding, so
    // the label starts on the same column as every other line in the card.
    expect(frame).toMatch(/openrouter\s+\n/);
    expect(frame).toMatch(/●\s+GLM-5\.2/);
    expect(frame).not.toContain("Recent");
});

test("ctrl+f on a model row asks that provider for its list again", () => {
    const state = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );

    expect(handleTuiSettingsPickerKey(state, { name: "f", ctrl: true }))
        .toMatchObject({ handled: true, refreshCatalog: "openrouter" });

    // A provider whose list Vera reads off disk rather than fetching has
    // nothing to ask for, so the key is swallowed instead of acted on.
    const row = state.options[state.selectedIndex] as TuiSettingsPickerOption;
    const onCodex = {
        ...state,
        options: [{ ...row, provider: "openai-codex", refreshable: false }],
        selectedIndex: 0,
    };
    const refused = handleTuiSettingsPickerKey(onCodex, {
        name: "f",
        ctrl: true,
    });
    expect(refused.handled).toBe(true);
    expect(refused.refreshCatalog).toBeUndefined();

    const ollama = {
        ...state,
        options: [{ ...row, provider: "ollama" }],
        selectedIndex: 0,
    };
    expect(handleTuiSettingsPickerKey(ollama, {
        name: "f",
        ctrl: true,
    })).toMatchObject({ handled: true, refreshCatalog: "ollama" });

    const omlx = {
        ...state,
        options: [{ ...row, provider: "omlx" }],
        selectedIndex: 0,
    };
    expect(handleTuiSettingsPickerKey(omlx, {
        name: "f",
        ctrl: true,
    })).toMatchObject({ handled: true, refreshCatalog: "omlx" });

    const declared = {
        ...state,
        options: [{ ...row, provider: "gateway", refreshable: true }],
        selectedIndex: 0,
    };
    expect(handleTuiSettingsPickerKey(declared, {
        name: "f",
        ctrl: true,
    })).toMatchObject({ handled: true, refreshCatalog: "gateway" });
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
    const second = updateTuiSettingsPickerSearch(state, "gl");

    expect(second.state?.query).toBe("gl");
    expect(modelRows(second.state!).map((option) => option.model)).toEqual([
        "z-ai/glm-5.2",
    ]);
    // A search result is still in provider order, so it keeps the headings
    // rather than repeating the provider on each row.
    const frame = await pickerFrame(second.state ?? state);
    expect(frame).toContain("gl");
    expect(frame).toMatch(/▼ openrouter/);
    expect(frame).toMatch(/GLM-5\.2/);
});

test("settings search edits at the native caret", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    let state = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "max",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );
    view.update(state);
    try {
        for (const name of ["g", "m", "left", "l"]) {
            state = view.handleEditorKey(state, {
                name,
                ...(name.length === 1 ? { sequence: name } : {}),
            }).state ?? state;
            view.update(state);
        }
        expect(state.query).toBe("glm");
        expect(state.queryCursor).toBe(2);
        expect(modelRows(state).map((option) => option.model)).toEqual([
            "z-ai/glm-5.2",
        ]);
    } finally {
        setup.renderer.destroy();
    }
});

test("settings paste filters once at the caret", async () => {
    const state = startTuiSettingsPicker(
        "model",
        "moonshotai/kimi-k3",
        "max",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiSettingsPickerView(setup.renderer);
    view.update(state);
    try {
        const transition = view.handleEditorPaste(state, "glm");
        expect(transition.state?.query).toBe("glm");
        expect(modelRows(transition.state!).map((option) => option.model)).toEqual([
            "z-ai/glm-5.2",
        ]);
    } finally {
        setup.renderer.destroy();
    }
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
    // The running model's own section is the one that opens; the rest are
    // headings with their counts.
    expect(rendered).toMatch(/ollama\s+\n/);
    expect(rendered).toContain("openrouter (2)");
});

test("every settings picker filters as the user types", async () => {
    const reasoning = startTuiReasoningPicker(REASONING_LEVELS, undefined, "high");
    const filteredReasoning = updateTuiSettingsPickerSearch(reasoning, "m");
    expect(filteredReasoning.state?.options.map((option) => option.value))
        .toEqual(["max", "medium"]);

    const permissions = startTuiSettingsPicker(
        "permissions",
        "z-ai/glm-5.2",
        "high",
        "auto",
    );
    const filteredPermissions = updateTuiSettingsPickerSearch(
        permissions,
        "full",
    ).state!;
    expect(filteredPermissions.options.map((option) => option.value))
        .toEqual(["full_access"]);
    expect(await pickerFrame(filteredPermissions)).toContain("full");
});

test("digits quick-select on the short panes and stay search input elsewhere", async () => {
    const settings = startTuiSettingsMenu("settings");
    const settingsFrame = await pickerFrame(settings);
    expect(settingsFrame).toContain("Model");
    expect(settingsFrame).not.toContain("1. Model");
    expect(handleTuiSettingsPickerKey(settings, { name: "2" }).selection)
        .toEqual({ kind: "menu", target: "reasoning" });

    const reasoning = startTuiReasoningPicker(REASONING_LEVELS, undefined, "high");
    expect(await pickerFrame(reasoning)).toContain("2. High");
    expect(handleTuiSettingsPickerKey(reasoning, { name: "3" }).selection)
        .toEqual({ kind: "reasoning", reasoningEffort: "medium" });
    // A digit past the list swallows rather than searches: there is no row 9,
    // and "9" is not a level name being typed.
    expect(handleTuiSettingsPickerKey(reasoning, { name: "9" }))
        .toMatchObject({ handled: true });

    // Once a query filters the list, digits are search input again and the
    // numbers leave the rows.
    const filtered = updateTuiSettingsPickerSearch(reasoning, "m");
    expect(await pickerFrame(filtered.state!)).not.toContain("1. Max");
    expect(handleTuiSettingsPickerKey(filtered.state!, { name: "1" })
        .selection).toBeUndefined();

    // Model names carry digits, so the model pane keeps them for search.
    const model = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "auto",
        [{
            provider: "openrouter",
            model: "z-ai/glm-5.2",
            label: "GLM 5.2",
            description: "",
        }],
    );
    const typed = updateTuiSettingsPickerSearch(model, "5");
    expect(typed.selection).toBeUndefined();
    expect(typed.state?.query).toBe("5");
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
        ["ask", "auto", "full_access", "readonly", "unattended"],
    );

    expect(permissions.options.map((option) => option.value)).toEqual([
        "ask",
        "auto",
        "full_access",
        "readonly",
        "unattended",
    ]);
    expect(permissions.options.at(-2)).toMatchObject({
        label: "Readonly",
        description: "allow reads and deny changes",
    });
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

test("configure picker lists concrete files by scope without search", async () => {
    const files = [{
        label: "Profile config",
        path: "/home/nash/.vera/profiles/dev/config.json",
        displayPath: "~/.vera/profiles/dev/config.json",
        scope: "Profile",
        createIfMissing: true,
    }, {
        label: "TUI preferences",
        path: "/home/nash/.vera/profiles/dev/tui.json",
        displayPath: "~/.vera/profiles/dev/tui.json",
        scope: "Profile",
        createIfMissing: false,
    }, {
        label: "Project config",
        path: "/work/vera/.vera/config.json",
        displayPath: ".vera/config.json",
        scope: "Project",
        createIfMissing: false,
    }] as const;
    const picker = startTuiConfigurePicker(files);

    expect(picker.options.map((option) => [
        option.label,
        option.description,
        option.group,
    ])).toEqual([
        ["Profile config", "~/.vera/profiles/dev/config.json", "Profile"],
        ["TUI preferences", "~/.vera/profiles/dev/tui.json", "Profile"],
        ["Project config", ".vera/config.json", "Project"],
    ]);
    expect(pickerFooter(picker)).toBe("↑↓ move · ⏎ edit · esc close");

    const typed = handleTuiSettingsPickerKey(picker, { name: "x" });
    expect(typed.handled).toBe(true);
    expect(typed.state?.query).toBe("");

    const frame = await pickerFrame(picker);
    expect(frame).toContain("Choose a configuration file to edit");
    expect(frame).toContain(
        "These files are the daily Vera home.",
    );
    expect(frame).toContain("Profile");
    expect(frame).toContain("Project");
    expect(frame).not.toContain("Search");

    const moved = handleTuiSettingsPickerKey(picker, { name: "down" });
    expect(handleTuiSettingsPickerKey(
        moved.state ?? picker,
        { name: "enter" },
    ).selection).toEqual({ kind: "configure", file: files[1] });
    expect(handleTuiSettingsPickerKey(picker, { name: "escape" })).toEqual({
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
        "context_limit",
        "developer",
        "permissions",
        "reviewer",
        "theme",
    ]);
    const permissions = updateTuiSettingsPickerSearch(settings, "perm").state!;
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

test("the context limit picker offers auto and fixed global ceilings", () => {
    const picker = startTuiContextLimitPicker(204_800);
    expect(picker.options[picker.selectedIndex]?.label).toBe("200k");
    expect(handleTuiSettingsPickerKey(picker, { name: "enter" }).selection)
        .toEqual({ kind: "context_limit", limit: 204_800 });

    const automatic = startTuiContextLimitPicker(undefined);
    expect(handleTuiSettingsPickerKey(automatic, { name: "enter" }).selection)
        .toEqual({ kind: "context_limit", limit: null });
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
        "Quickslots",
        [
            { id: "fast", label: "Fast", description: "quick model" },
            { id: "deep", label: "Deep", description: "reasoning model" },
        ],
        "deep",
        [
            { id: "apply", key: "enter", label: "apply" },
            { id: "default", key: "d", label: "default" },
            { id: "save", key: "s", label: "save" },
            { id: "clear-delete", key: "delete", label: "clear" },
            { id: "clear-backspace", key: "backspace", label: "clear" },
        ],
        "Switching models may make the next turn slower.",
    );

    expect(state.kind).toBe("extension");
    expect(state.title).toBe("Quickslots");
    expect(state.extensionRows?.map((row) => row.id)).toEqual([
        "fast",
        "deep",
    ]);
    expect(state.selectedId).toBe("deep");
    expect(state.selectedIndex).toBe(1);

    const frame = await pickerFrame(state);
    expect(frame).toContain("Quickslots");
    expect(frame).toContain("Switching models may make the next turn slower.");
    expect(frame).toContain("Fast");
    expect(frame).toContain("Deep");
    expect(frame).toContain("⏎ apply");
    expect(frame).toContain("d default");
    expect(frame).toContain("s save");
    expect(frame).toContain("del clear");
    expect(frame).toContain("⌫ clear");
    expect(frame).not.toContain("Search");
});

test("an extension picker separates its subtitle from title and rows", async () => {
    const state = startTuiExtensionPicker(
        "Agents",
        [{ id: "default", label: "default" }, { id: "plan", label: "plan" }],
        "default",
        [{ id: "wear", key: "enter", label: "switch" }],
        "Switching agents re-reads the prefix, so the next turn is slower once.",
    );
    const frame = await pickerFrame(
        state,
        100,
        30,
    );
    const lines = frame.split("\n");
    const title = lines.findIndex((line) => line.includes("Agents"));
    const firstSubtitle = lines.findIndex((line) =>
        line.includes("Switching agents re-reads")
    );
    const firstRow = lines.findIndex((line) => line.includes("default"));
    expect(firstSubtitle).toBe(title + 2);
    expect(lines[title + 1]?.trim()).toBe("");
    expect(lines[firstRow - 1]?.trim()).toBe("");
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
            { id: "default", key: "d", label: "default" },
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
    expect(handleTuiSettingsPickerKey(selected, { name: "d" }).selection)
        .toEqual({ kind: "extension", rowId: "second", actionId: "default" });
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
        "muted-blue",
        "orng",
        "palenight",
        "synthwave",
        "nightowl",
        "github",
        "midnight-blue",
        "midnight-blue-ii",
        "norton-commander",
        "nc-navy",
        "windows-31",
    ]);
    expect(themes.options[themes.selectedIndex]?.value).toBe("nightowl");
    const filtered = updateTuiSettingsPickerSearch(themes, "owl").state!;
    expect(filtered.options.map((option) => option.value)).toEqual([
        "nightowl",
    ]);
    expect(handleTuiSettingsPickerKey(themes, { name: "down" }).previewTheme)
        .toBe("github");
    expect(handleTuiSettingsPickerKey(themes, { name: "escape" }).previewTheme)
        .toBe("nightowl");
    expect(updateTuiSettingsPickerSearch(filtered, "ow").previewTheme)
        .toBe("nightowl");
});

test("Norton Commander renders the theme picker with retro styling", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    applyTuiTheme(await resolveTuiTheme(setup.renderer, "norton-commander"));
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(startTuiSettingsPicker(
        "theme",
        undefined,
        undefined,
        undefined,
        undefined,
        "norton-commander",
    ));
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(view.box.border).toBe(false);
        expect(frame).toContain("[Esc]");
        expect(frame).toContain("● NC");
        expect(view.box.screenY).toBeGreaterThan(0);
        expect(view.box.screenY + view.box.height)
            .toBeLessThanOrEqual(setup.renderer.height);
    } finally {
        applyTuiTheme(VERA_TUI_THEME);
        setup.renderer.destroy();
    }
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
        const rows = frame.split("\n");
        const defaultRow = rows.find((row) => row.includes("Default"));
        const midnightBlueIiRow = rows.find((row) => row.includes("Midnight Blue II"));
        expect(midnightBlueIiRow?.indexOf("██ ██ ██ ██"))
            .toBe(defaultRow?.indexOf("██ ██ ██ ██"));
        // System is terminal-derived, so it shows a neutral placeholder swatch.
        expect(frame).toContain("░░ ░░ ░░ ░░");
        expect(frame).toContain("↑↓ move · ⏎ apply · esc cancel");
        expect(frame).not.toContain("┌");
        expect(view.box.border).toBe(false);
    } finally {
        setup.renderer.destroy();
    }
});

const pooledModels = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        available: true,
        verified: true,
        description: "frontier coding model",
        levels: [],
    },
    {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        available: false,
        verified: true,
        levels: [],
    },
] as const;

function modelPickerWithPool(
    pooled: readonly PooledModel[] = pooledModels,
    currentModel = "z-ai/glm-5.2",
    currentProvider = "openrouter",
) {
    return startTuiSettingsPicker(
        "model",
        currentModel,
        "max",
        "auto",
        availableModels,
        "default",
        currentProvider,
        undefined,
        pooled,
    );
}

function typedInto(
    start: TuiSettingsPickerState,
    text: string,
): TuiSettingsPickerState {
    return updateTuiSettingsPickerSearch(start, text).state ?? start;
}

test("an empty model list says which emptiness it is", async () => {
    const searched = typedInto(modelPickerWithPool(), "zzqq");
    expect(searched.options).toHaveLength(0);
    const searchedFrame = await pickerFrame(searched);
    expect(searchedFrame).toContain("No shortlisted models match");
    expect(searchedFrame).toContain("Tab switches to All models");

    // Nothing shortlisted and no current model leaves More with no actions to
    // hold, so the copy must not send the user to a row that is not drawn.
    const bare = switchedModelTab(modelPickerWithPool([], "", ""), "pool");
    const bareFrame = await pickerFrame(bare);
    expect(bareFrame).toContain("Nothing shortlisted yet");
    expect(bareFrame).toContain("Tab switches to All models");
    expect(bareFrame).not.toMatch(/More\s+.*\u203a/);

    const withMore = {
        ...switchedModelTab(
            modelPickerWithPool([], "z-ai/glm-5.2", "openrouter"),
            "pool",
        ),
        actionOptions: tuiModelActionOptions(["openrouter"], { hasPool: true }),
    };
    const moreFrame = await pickerFrame(withMore);
    expect(moreFrame).toMatch(/More\s+.*\u203a/);
    expect(moreFrame).toContain("More above adds the current");

    const noCatalog = { ...bare, modelCatalogUnavailable: true };
    const noCatalogFrame = await pickerFrame(noCatalog);
    expect(noCatalogFrame).toContain("Models arrive with a conversation");
    expect(noCatalogFrame).not.toContain("Nothing shortlisted yet");
});

test("an empty model list stays put on Down and reaches More with one Up", () => {
    const empty = {
        ...switchedModelTab(
            modelPickerWithPool([], "z-ai/glm-5.2", "openrouter"),
            "pool",
        ),
        actionOptions: tuiModelActionOptions(["openrouter"], { hasPool: true }),
    } as TuiSettingsPickerState;
    expect(empty.options).toHaveLength(0);

    const down = handleTuiSettingsPickerKey(empty, { name: "down" }).state!;
    expect(down.selectedIndex).toBe(0);
    expect(down.modelFocus).toBe("list");

    const up = handleTuiSettingsPickerKey(down, { name: "up" }).state!;
    expect(up.selectedIndex).toBe(0);
    expect(up.modelFocus).toBe("page_entry");
});

test("a search that matches no model says so on All models", async () => {
    const empty = startTuiSettingsPicker(
        "model",
        "",
        undefined,
        "auto",
        [],
        "default",
        "",
        undefined,
        [],
    );
    const all = switchedModelTab(empty, "all");
    expect(all.tab).toBe("all");
    expect(await pickerFrame(typedInto(all, "zzqq")))
        .toContain("No models match that search");
});

test("the model pane opens on Shortlist, in the order the user's own use produced", async () => {
    const state = modelPickerWithPool();
    const frame = await pickerFrame(state);

    expect(state.tab).toBe("pool");
    // Pool order, not provider order: the pool is ordered by when each model
    // was added, and sorting it by provider would throw that away.
    expect(state.options.map((option) => option.model)).toEqual([
        "gpt-5.6-sol",
        "z-ai/glm-5.2",
    ]);
    // An entry that cannot run right now stays in the list: the user put it
    // there, so only the user takes it out. It says so in the column that would
    // otherwise carry its provider, since that is the one fact about the row a
    // heading could never carry.
    expect(frame).toContain("unavail");
    expect(frame).not.toContain("unavailable");
    expect(frame).toContain("GLM-5.2");
    expect(frame).not.toContain("Z-AI: GLM-5.2");
    expect(frame).toContain("Shortlist");
    expect(frame).toMatch(
        /Shortlist \(2\).*All(?: models)? \(2\).*\n\s*\n.*Models you keep close\..*\n\s*\n.*GPT-5\.6-Sol/,
    );
});

test("the model tab strip keeps every stop inside the card at narrow widths", async () => {
    for (const width of [70, 60, 40]) {
        const frame = await pickerFrame(modelPickerWithPool(), width, 40);
        expect(frame).toMatch(/Short(?:list)?/);
        expect(frame).toContain("All");
        expect(frame).toMatch(/Def(?:s|aults)/);
        expect(frame).toContain("Help");
        expect(frame).toContain("Providers ^e");

        const strip = frame.split("\n")
            .find((line) => line.includes("Providers ^e"))!;
        const providersEnd = strip.indexOf("Providers ^e")
            + Bun.stringWidth("Providers ^e");
        const cardRightEdge = Math.floor(width * 0.98);
        expect(providersEnd).toBeLessThanOrEqual(cardRightEdge);
        if (width === 40) {
            const lines = frame.split("\n");
            const firstTabRow = lines.findIndex((line) => line.includes("Short"));
            const providersRow = lines.findIndex((line) =>
                line.includes("Providers ^e")
            );
            expect(providersRow).toBeGreaterThan(firstTabRow);
            expect(frame).toContain("Arrow keys move you");
        }
    }
});

test("the model pane's rows stay inside the card when it sits beside a workspace rail", async () => {
    // Mirrors what main.ts's `fitSettingsPickerBesideWorkspace` does when the
    // workspace rail stays open beside the model pane: the card is narrowed
    // and shifted right by the rail's width, so its own content has to be
    // built for that narrower width too, or the detail column (drawn from
    // `modelPaneSplit`/`pickerCardWidth`) runs past the card's right edge.
    const width = 160;
    const height = 40;
    const railInset = 44;
    const setup = await createTestRenderer({ width, height });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;

    view.update(modelPickerWithPool(), railInset);
    const chatColumns = Math.max(0, width - railInset);
    view.box.left = railInset + Math.floor(chatColumns * 0.02);
    view.box.width = Math.max(20, Math.floor(chatColumns * 0.96));
    await setup.flush();

    const cardRight = (view.box.left as number) + (view.box.width as number);
    const frame = setup.captureCharFrame();
    for (const line of frame.split("\n")) {
        const rightmost = line.trimEnd().length;
        expect(rightmost).toBeLessThanOrEqual(cardRight);
    }
    setup.renderer.destroy();
});

test("the pane opens on Shortlist even when the running model is not in it", () => {
    // The pool is the list the user built for this moment, so it opens whether
    // or not the model in effect happens to be on it.
    const state = modelPickerWithPool(pooledModels, "sonnet-4.5", "anthropic");
    expect(state.tab).toBe("pool");
});

test("Shortlist offers the current model as a visible action row", async () => {
    const base = modelPickerWithPool(
        pooledModels,
        "moonshotai/kimi-k3",
        "openrouter",
    );
    const withAction = {
        ...base,
        actionOptions: tuiModelActionOptions(["openrouter"], {
            hasPool: true,
            currentModel: {
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
                shortlisted: false,
            },
        }),
    } as TuiSettingsPickerState;
    const shortlist = {
        ...switchedModelTab(withAction, "pool"),
        selectedIndex: 0,
    };

    // The shortlist column holds models and nothing else. Adding the current
    // one is something the list can do, so it lives on the More page above.
    expect(shortlist.options.every((option) =>
        option.label !== "Add current model to shortlist"
    )).toBe(true);
    const shortlistFrame = await pickerFrame(shortlist);
    expect(shortlistFrame).toMatch(/More\s+.*\u203a/);
    expect(shortlistFrame).not.toContain("Add current model to sh");

    const page = handleTuiSettingsPickerKey(
        handleTuiSettingsPickerKey(shortlist, { name: "up" }).state!,
        { name: "return" },
    ).state!;
    expect(await pickerFrame(page)).toContain("Add current model");

    const synced = syncTuiModelPicker(shortlist, {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        availableModels,
        pooled: [
            ...pooledModels,
            {
                provider: "openrouter",
                model: "moonshotai/kimi-k3",
                label: "Kimi K3",
                available: true,
                verified: false,
                levels: [],
            },
        ],
    });
    expect(synced.options.some((option) =>
        option.label === "Add current model to shortlist"
    )).toBe(false);
});

test("the current shortlist model exposes an inspector and list action", async () => {
    const shortlist = modelPickerWithPool(
        pooledModels,
        "z-ai/glm-5.2",
        "openrouter",
    );

    expect(shortlist.options.some((option) =>
        option.label === "Verify current model"
    )).toBe(false);
    const frame = await pickerFrame(shortlist);
    // Verifying the whole shortlist is something the list does, so it sits on
    // the More page with the rest rather than on a band of its own.
    expect(frame).not.toContain("Verify all");
    expect(frame).toContain("Actions");
    expect(frame).toMatch(/Verify this model\s+\^v/);
    expect(frame).toMatch(/Unpin\s+\^s/);
    expect(frame).toMatch(/Name this model\s+\^n/);
    expect(frame).not.toContain("Refresh model catalog from providers");
    expect(pickerFooter(shortlist)).toContain("^v verify");
    expect(pickerFooter(shortlist)).toContain("→ actions");
    expect(handleTuiSettingsPickerKey(shortlist, { name: "enter" }).selection)
        .toEqual({
            kind: "model",
            provider: "openrouter",
            model: "z-ai/glm-5.2",
        });
    expect(handleTuiSettingsPickerKey(shortlist, { name: "v", ctrl: true })
        .poolVerify).toEqual({
            provider: "openrouter",
            model: "z-ai/glm-5.2",
        });
    expect(handleTuiSettingsPickerKey(
        shortlist,
        { name: "v", ctrl: true, shift: true },
    ).poolVerifySweep).toBe(true);
});

test("right and left move between a model row and its inspector", async () => {
    const shortlist = modelPickerWithPool(
        pooledModels,
        "z-ai/glm-5.2",
        "openrouter",
    );
    const detail = handleTuiSettingsPickerKey(shortlist, { name: "right" })
        .state!;
    expect(detail.modelFocus).toBe("detail");
    expect(detail.modelActionIndex).toBe(0);
    expect(await pickerFrame(detail)).toMatch(/│  Verify this model/);
    expect(handleTuiSettingsPickerKey(detail, { name: "enter" }).poolVerify)
        .toEqual({ provider: "openrouter", model: "z-ai/glm-5.2" });

    const remove = handleTuiSettingsPickerKey(detail, { name: "down" }).state!;
    expect(await pickerFrame(remove)).toMatch(/│  Unpin/);
    expect(handleTuiSettingsPickerKey(remove, { name: "enter" }).poolToggle)
        .toEqual({
            action: "remove",
            provider: "openrouter",
            model: "z-ai/glm-5.2",
        });

    const named = handleTuiSettingsPickerKey(remove, { name: "down" }).state!;
    expect(handleTuiSettingsPickerKey(named, { name: "enter" }).poolName)
        .toEqual({
            provider: "openrouter",
            model: "z-ai/glm-5.2",
            label: "GLM-5.2",
        });
    expect(handleTuiSettingsPickerKey(named, { name: "left" }).state?.modelFocus)
        .toBe("list");

    const nextTab = handleTuiSettingsPickerKey(detail, { name: "tab" }).state!;
    expect(nextTab.tab).toBe("all");
    expect(nextTab.modelFocus).toBe("list");
});

test("supported model inspectors expose exact request-option state and action", async () => {
    const support = {
        providerLabel: "OpenRouter",
        label: "OpenRouter request body",
        explanation: "Added to the OpenRouter request body.",
        documentationUrl: "https://openrouter.ai/docs/guides/routing/provider-selection",
    };
    const base = modelPickerWithPool(
        pooledModels,
        "z-ai/glm-5.2",
        "openrouter",
    );
    const unset: TuiSettingsPickerState = {
        ...base,
        requestOptionsProviders: { openrouter: support },
        configuredRequestOptions: [],
    };
    expect(await pickerFrame(unset)).toMatch(/Request options\s+none/);

    const configured = {
        ...unset,
        configuredRequestOptions: ["openrouter/z-ai/glm-5.2"],
    };
    expect(await pickerFrame(configured)).toMatch(
        /Request options\s+configured/,
    );

    const detail = handleTuiSettingsPickerKey(configured, { name: "right" })
        .state!;
    const requestRow = ["down", "down", "down"].reduce(
        (state, name) => handleTuiSettingsPickerKey(state, { name }).state!,
        detail,
    );
    const keyboard = handleTuiSettingsPickerKey(requestRow, { name: "enter" })
        .requestOptions;
    expect(keyboard).toEqual({
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        support,
    });

    const clicked = moveTuiSettingsPickerPointer(
        configured,
        configured.options.length + 4,
    ) as TuiSettingsPickerState;
    expect(handleTuiSettingsPickerKey(clicked, { name: "enter" }).requestOptions)
        .toEqual(keyboard);

    const unsupported = { ...configured, selectedIndex: 0 };
    expect(await pickerFrame(unsupported)).not.toContain("Request options");
});

test("verifying the shortlist lives on More, and every row is clickable", async () => {
    const shortlist = {
        ...modelPickerWithPool(),
        selectedIndex: 1,
        actionOptions: tuiModelActionOptions(["openrouter"], { hasPool: true }),
    };
    // The last row is the end of the list. There is nothing below it to fall
    // onto any more.
    const below = handleTuiSettingsPickerKey(shortlist, { name: "down" }).state!;
    expect(below.modelFocus ?? "list").toBe("list");

    const page = handleTuiSettingsPickerKey(
        handleTuiSettingsPickerKey(
            { ...shortlist, selectedIndex: 0 },
            { name: "up" },
        ).state!,
        { name: "return" },
    ).state!;
    expect(page.modelFocus).toBe("page");
    const pageFrame = await pickerFrame(page);
    expect(pageFrame).toMatch(/Verify shortlisted models\s+\^⇧v/);
    // The sign follows the pane: shut it offers to open, open it offers to
    // close, whichever row the cursor is on.
    expect(await pickerFrame(shortlist)).toContain("+ More");
    expect(pageFrame).toContain("- More");
    const sweep = [0, 1, 2].map((index) =>
        handleTuiSettingsPickerKey(
            { ...page, modelPageIndex: index },
            { name: "return" },
        ).poolVerifySweep
    );
    expect(sweep).toContain(true);

    const inspectorClick = moveTuiSettingsPickerPointer(
        shortlist,
        shortlist.options.length + 1,
    ) as TuiSettingsPickerState;
    expect(inspectorClick.modelFocus).toBe("detail");
    expect(handleTuiSettingsPickerKey(inspectorClick, { name: "enter" })
        .poolVerify).toEqual({
            provider: "openrouter",
            model: "z-ai/glm-5.2",
        });

    const modelClick = moveTuiSettingsPickerPointer(
        shortlist,
        0,
    ) as TuiSettingsPickerState;
    expect(modelClick.modelFocus).toBe("list");
    expect(modelClick.selectedIndex).toBe(0);
    expect(handleTuiSettingsPickerKey(modelClick, { name: "enter" }).selection)
        .toEqual({
            kind: "model",
            provider: "openai-codex",
            model: "gpt-5.6-sol",
        });
});

test("a main shortlist refresh keeps the side agent's current model", () => {
    const side = {
        provider: "side-provider",
        model: "side/model",
        availableModels: [{
            provider: "side-provider",
            model: "side/model",
            label: "Side",
            description: "the side agent's catalog model",
            levels: [],
        }],
        pooled: pooledModels,
    };
    const refreshed = {
        provider: "main-provider",
        model: "main/model",
        pooled: [{
            provider: "side-provider",
            model: "side/model",
            label: "Side",
            available: true,
            verified: false,
            levels: [],
        }],
    };

    expect(mergeTuiModelPickerSettings(side, refreshed)).toEqual({
        ...side,
        pooled: refreshed.pooled,
    });
});

test("with an empty pool the pane opens on All models, full width", async () => {
    // An empty tab answers no question, so the pane falls back to the list that
    // can always answer "which model do I switch to".
    const state = modelPickerWithPool([]);
    expect(state.tab).toBe("all");
    const frame = await pickerFrame(state);
    expect(frame).toMatch(/All(?: models)? \(\d+\)/);
    expect(frame).not.toMatch(/│ Full price/);
    expect(frame).not.toContain("┌");
    expect(frame).not.toContain("└");
});

test("All models keeps a moderate modal height on a tall terminal", async () => {
    const models = Array.from({ length: 40 }, (_, index) => ({
        provider: "openrouter",
        model: `example/model-${index}`,
        label: `Model ${index}`,
        description: "runnable",
    }));
    const state = startTuiSettingsPicker(
        "model",
        models[0]!.model,
        undefined,
        "auto",
        models,
        "default",
        "openrouter",
        undefined,
        [],
    );
    const setup = await createTestRenderer({ width: 100, height: 50 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(state);
    try {
        await setup.flush();
        expect(state.tab).toBe("all");
        expect(tuiPickerViewportRows(setup.renderer, state)).toBe(14);
        expect(tuiPickerViewportRows(setup.renderer, state)).toBeLessThan(40);
        expect(view.box.height).toBeLessThan(
            setup.renderer.height - 4,
        );
        expect(setup.renderer.height - view.box.screenY - view.box.height)
            .toBeGreaterThanOrEqual(4);
    } finally {
        setup.renderer.destroy();
    }
});

test("⇥ moves to All models, which lists what can run", async () => {
    const state = modelPickerWithPool();
    const allTab = handleTuiSettingsPickerKey(state, { name: "tab" }).state;

    expect(allTab?.tab).toBe("all");
    // A pool model that cannot run right now is not offered here: choosing it
    // would be a dead end. It keeps its row on the Pool tab.
    expect(modelRows(allTab!).map((option) => option.model)).toEqual([
        "z-ai/glm-5.2",
        "moonshotai/kimi-k3",
    ]);
    expect(await pickerFrame(allTab!)).not.toContain("not available right now");

    // The cycle is Pool, All models, Actions, Defaults, Help, and round again.
    const actions = handleTuiSettingsPickerKey(allTab!, { name: "tab" }).state!;
    expect(actions.tab).toBe("actions");
    const slots = handleTuiSettingsPickerKey(actions, { name: "tab" }).state!;
    expect(slots.tab).toBe("defaults");
    const help = handleTuiSettingsPickerKey(slots, { name: "tab" }).state!;
    expect(help.tab).toBe("help");
    expect(handleTuiSettingsPickerKey(help, { name: "tab" }).state?.tab)
        .toBe("pool");
});

const RECOMMENDED_FIXTURE = [
    {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        label: "Kimi K3",
        description: "runnable",
        recommended: true,
        recommendedLevel: "medium",
    },
    {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        description: "runnable",
    },
];

/** The model rows of a sectioned list, headings dropped. */
function modelRows(
    state: TuiSettingsPickerState,
): readonly TuiSettingsPickerOption[] {
    return state.options.filter((option) => option.section === undefined);
}

function allTabWithRecommendations(): TuiSettingsPickerState {
    const state = startTuiSettingsPicker(
        "model",
        undefined,
        undefined,
        undefined,
        RECOMMENDED_FIXTURE,
    );
    expect(state.tab).toBe("all");
    return state;
}

/** The heading rows a sectioned list carries, with their fold state. */
function sectionRows(
    state: TuiSettingsPickerState,
): readonly (readonly [string, boolean])[] {
    return state.options
        .filter((option) => option.section !== undefined)
        .map((option) => [option.section!, option.sectionCollapsed === true]);
}

test("All models opens on Top picks, with the providers folded", () => {
    const state = allTabWithRecommendations();

    expect(state.options.map((option) => option.label)).toEqual([
        "Top picks",
        "Kimi K3",
        "openrouter (2)",
    ]);
    expect(state.collapsed).toEqual(["openrouter"]);
    // The section is a second listing of the same model, not a second model:
    // the pane still holds one row per model behind the views.
    expect(state.allOptions.filter((option) =>
        option.model === "moonshotai/kimi-k3"
    )).toHaveLength(1);
});

test("a top pick says so on its own row, except under the heading that says it", async () => {
    const frame = await pickerFrame(allTabWithRecommendations(), 100, 55);

    // Under the Top picks heading the words would only repeat it.
    expect(frame).not.toContain("top pick");
    const opened = await pickerFrame(
        handleTuiSettingsPickerKey(
            { ...allTabWithRecommendations(), selectedIndex: 2 },
            { name: "return" },
        ).state!,
        100,
        55,
    );
    expect(opened).toMatch(/Kimi K3\s+top pick/);
});

test("a tab is switched by clicking its chip, cursor and all", () => {
    const state = modelPickerWithPool();

    // The click path is the key path: whatever ⇥ would do landing on that tab
    // is what a click on it does.
    expect(switchedModelTab({ ...state, query: "glm" }, "all"))
        .toEqual(handleTuiSettingsPickerKey(
            { ...state, query: "glm" },
            { name: "tab" },
        ).state as TuiSettingsPickerState);
});

test("the Help tab explains the pane in the pane", async () => {
    const state = modelPickerWithPool();
    const help = switchedModelTab(state, "help");
    const frame = await pickerFrame(help, 100, 50);

    expect(frame).toContain("the model this conversation is running");
    expect(frame).toContain("answered a live probe");
    expect(frame).toContain("WebDev Arena");
    expect(frame).toContain("CC-BY 4.0");
    expect(frame).toContain("OpenRouter");
    expect(frame).toContain("on or near Vera's WA Score × listed-output front");
    expect(frame).toContain("★");
    expect(frame).toContain("the model takes image input");
    expect(frame).not.toContain("🖼");
    expect(frame).toContain("snapshot unavailable");
    expect(frame).toContain("on WA Score: source footnote, not the shortlist.");
    expect(frame).toContain("7:2:1");
    // A page, not a list: nothing to filter, nothing to select, and the footer
    // says only what the page can do.
    expect(help.options).toHaveLength(0);
    // The search field stays in place even though this page holds nothing to
    // filter: dropping it would lift the tabs and the page under them as the
    // user tabs onto Help and drop them again on the way off.
    const lines = frame.split("\n").map((line) => line.trim())
        .filter((line) => line.length > 0);
    const title = lines.findIndex((line) => line.startsWith("Select model"));
    expect(lines[title + 1]).toBe("Search");
    expect(lines[title + 2]).toStartWith("Shortlist (2)");
    expect(frame).toContain("⇥ tabs · esc close");
    // The chip carries no count, because Help is not a collection of models.
    expect(frame).toMatch(/Help\s/);
    expect(frame).not.toMatch(/Help \d/);
});

function listedFactsModels() {
    return {
        available: [
            {
                provider: "openrouter",
                model: "x-ai/grok-4.6",
                label: "SpaceXAI: Grok 4.6",
                description: "runnable",
                refreshable: true,
                recommended: true,
                waScore: 1629,
                pricing: { input: 3, output: 15 },
                onPareto: true,
                imageSupport: true,
            },
            {
                provider: "openrouter",
                model: "other/steady",
                label: "Steady",
                description: "runnable",
                refreshable: true,
                waScore: 1400,
                pricing: { input: 1, output: 4 },
            },
            {
                provider: "openrouter",
                model: "unknown/blank",
                label: "Unknown Blank",
                description: "runnable",
                refreshable: true,
            },
        ],
        pooled: [{
            provider: "openrouter",
            model: "x-ai/grok-4.6",
            label: "SpaceXAI: Grok 4.6",
            available: true,
            verified: true,
            levels: [],
            waScore: 1629,
            pricing: { input: 3, output: 15 },
            onPareto: true,
            imageSupport: true,
        }],
    } as const;
}

function listedFactsPicker() {
    const models = listedFactsModels();
    return startTuiSettingsPicker(
        "model",
        "x-ai/grok-4.6",
        undefined,
        "auto",
        models.available,
        "default",
        "openrouter",
        undefined,
        models.pooled,
    );
}

test("All models shows listed facts, glyphs, and a blank unmatched score", async () => {
    const all = switchedModelTab(listedFactsPicker(), "all");
    const frame = await pickerFrame(all, 100, 55);

    expect(frame).toContain("WA Score");
    expect(frame).toContain("1629");
    expect(frame).toContain("4.2");
    expect(frame).toMatch(/\bP\b/);
    expect(frame).toContain("★");
    expect(frame).toMatch(/P i ★/);
    expect(frame).not.toContain("🖼");
    expect(frame).toContain("Unknown Blank");
    expect(frame).not.toMatch(/Unknown Blank[^\n]*\b0\b/);
    expect(frame).not.toMatch(/shortlisted/);
    expect(frame).not.toContain("$");
    expect(frame).toContain("Full price");
    expect(frame).toContain("3/15");
    expect(frame).toContain("Blended price");
    const fullPriceAt = frame.indexOf("Full price");
    expect(frame.slice(0, fullPriceAt)).toContain("Grok 4.6");
    expect(frame.indexOf("Unknown Blank")).toBeLessThan(fullPriceAt);
    expect(frame).toContain("7:2:1");
    expect(frame).toContain("Any");
    expect(frame).toContain("Smarter");
    expect(frame).toMatch(/any\s+1400\s+1450\s+1500\s+1550\s+1600/);
    expect(frame).not.toMatch(/│ Full price/);
    expect(frame).not.toContain("┌");
    expect(frame).not.toContain("└");
    const headerLine = frame.split("\n").find((line) =>
        line.includes("WA Score*")
    )!;
    expect(headerLine).toContain("7:2:1");
    expect(headerLine).not.toContain("3/15");
    const grokPick = frame.split("\n").find((line) =>
        line.includes("Grok 4.6") && line.includes("top pick")
    );
    const steadyLine = frame.split("\n").find((line) =>
        line.includes("Steady") && line.includes("1400")
    )!;
    expect(grokPick).toBeDefined();
    expect(grokPick).toContain("4.2");
    expect(grokPick).not.toContain("3/15");
    expect(steadyLine).toContain("1.3");
    expect(steadyLine).not.toContain("1/4");
    expect(grokPick!.indexOf("1629")).toBe(steadyLine.indexOf("1400"));
});

test("All models intelligence cutoff hides rows below the WA Score floor", () => {
    const all = { ...switchedModelTab(listedFactsPicker(), "all"), selectedIndex: 0 };
    const focused = handleTuiSettingsPickerKey(all, { name: "up" }).state!;
    expect(focused.modelFocus).toBe("intelligence");

    const floor = handleTuiSettingsPickerKey(focused, { name: "right" }).state!;
    expect(floor.intelligenceCutoff).toBe("1400");
    const floorNames = floor.options
        .filter((option) => option.section === undefined)
        .map((option) => option.label);
    expect(floorNames).toContain("SpaceXAI: Grok 4.6");
    expect(floorNames).toContain("Steady");
    expect(floorNames).not.toContain("Unknown Blank");

    const tighter = handleTuiSettingsPickerKey(floor, { name: "right" }).state!;
    expect(tighter.intelligenceCutoff).toBe("1450");
    const tightNames = tighter.options
        .filter((option) => option.section === undefined)
        .map((option) => option.label);
    expect(tightNames).toContain("SpaceXAI: Grok 4.6");
    expect(tightNames).not.toContain("Steady");

    let top = tighter;
    for (const stop of ["1500", "1550", "1600"] as const) {
        top = handleTuiSettingsPickerKey(top, { name: "right" }).state!;
        expect(top.intelligenceCutoff).toBe(stop);
    }
    const topNames = top.options
        .filter((option) => option.section === undefined)
        .map((option) => option.label);
    expect(topNames).toContain("SpaceXAI: Grok 4.6");
    expect(topNames).not.toContain("Steady");
});

test("Shortlist keeps names on the list and listed facts in the inspector", async () => {
    const frame = await pickerFrame(listedFactsPicker(), 160);

    expect(frame).not.toMatch(/WA Score\*/);
    expect(frame).toContain("WA Score");
    expect(frame).toContain("1629");
    expect(frame).toContain("Full price");
    expect(frame).toContain("3/15");
    expect(frame).toContain("Blended price");
    expect(frame).toContain("7:2:1");
    expect(frame).toMatch(/│  Images\b/);
    expect(frame).toMatch(/│  i\b/);
    expect(frame).toContain("✓");
    expect(frame).not.toContain("★");
    expect(frame).not.toContain("🖼");
});

test("the model tab strip offers the providers pane and its key", async () => {
    const frame = await pickerFrame(modelPickerWithPool());
    // The chip is not a fourth view, so ⇥ never lands on it. It carries the
    // chord that opens it instead: a chip that sits among the tabs and answers
    // to nothing on the keyboard is one the keyboard cannot reach at all.
    expect(frame).toContain("Providers ^e");
});

test("⏎ on a heading opens its section, and ⏎ again folds it", () => {
    const state = allTabWithRecommendations();
    const onHeading = { ...state, selectedIndex: 2 };

    const opened = handleTuiSettingsPickerKey(onHeading, { name: "return" })
        .state!;
    expect(opened.collapsed).toEqual([]);
    expect(opened.options.map((option) => option.label)).toEqual([
        "Top picks",
        "Kimi K3",
        "openrouter",
        "GLM-5.2",
        "Kimi K3",
    ]);
    // The cursor stays on the heading it just opened.
    expect(opened.options[opened.selectedIndex]?.section).toBe("openrouter");

    const folded = handleTuiSettingsPickerKey(opened, { name: "return" }).state!;
    expect(sectionRows(folded)).toEqual([
        ["Top picks", false],
        ["openrouter", true],
    ]);
    // The count is what a closed section says instead of its rows.
    expect(folded.options.at(-1)?.label).toBe("openrouter (2)");
});

test("← closes a section and → opens it, from the heading or a row under it", () => {
    const state = { ...allTabWithRecommendations(), selectedIndex: 0 };

    const closed = handleTuiSettingsPickerKey(state, { name: "left" }).state!;
    expect(closed.collapsed).toEqual(["openrouter", "Top picks"]);
    // Already closed: the key is claimed, and nothing else happens.
    expect(handleTuiSettingsPickerKey(closed, { name: "left" }).state)
        .toBe(closed);

    const open = handleTuiSettingsPickerKey(closed, { name: "right" }).state!;
    expect(open.collapsed).toEqual(["openrouter"]);

    // From inside a section, ← closes the section the row belongs to rather
    // than asking the user to walk back up to its heading first.
    const onModel = { ...state, selectedIndex: 1 };
    const foldedFromRow = handleTuiSettingsPickerKey(onModel, { name: "left" });
    expect(foldedFromRow.handled).toBe(true);
    expect(foldedFromRow.state!.collapsed).toEqual(["openrouter", "Top picks"]);
});

test("⇧← folds every section and ⇧→ opens every one", () => {
    const state = allTabWithRecommendations();

    const folded = handleTuiSettingsPickerKey(state, {
        name: "left",
        shift: true,
    }).state!;
    expect(sectionRows(folded)).toEqual([
        ["Top picks", true],
        ["openrouter", true],
    ]);

    // Either key answers for the whole list, whatever the sections were.
    const opened = handleTuiSettingsPickerKey(folded, {
        name: "right",
        shift: true,
    }).state!;
    expect(opened.collapsed).toEqual([]);
    expect(sectionRows(opened)).toEqual([
        ["Top picks", false],
        ["openrouter", false],
    ]);
    expect(opened.options.map((option) => option.label)).toEqual([
        "Top picks",
        "Kimi K3",
        "openrouter",
        "GLM-5.2",
        "Kimi K3",
    ]);
});

test("a fold survives a tab away and back, and a search opens everything", () => {
    const folded = allTabWithRecommendations();

    // All -> Actions -> Defaults -> Help -> Pool, the long way round the strip.
    let pool = folded;
    for (let step = 0; step < 4; step += 1) {
        pool = handleTuiSettingsPickerKey(pool, { name: "tab" }).state!;
    }
    expect(pool.tab).toBe("pool");
    const back = handleTuiSettingsPickerKey(pool, { name: "tab" }).state!;
    expect(back.tab).toBe("all");
    expect(sectionRows(back)).toEqual([
        ["Top picks", false],
        ["openrouter", true],
    ]);

    // A heading over hidden rows would claim the search found nothing there.
    const searched = updateTuiSettingsPickerSearch(folded, "g").state!;
    expect(modelRows(searched).map((option) => option.label)).toEqual([
        "GLM-5.2",
    ]);
    expect(sectionRows(searched)).toEqual([["openrouter", false]]);

    // Clearing the query puts the fold back.
    const cleared = updateTuiSettingsPickerSearch(searched, "").state!;
    expect(sectionRows(cleared)).toEqual([
        ["Top picks", false],
        ["openrouter", true],
    ]);
});

test("the footer names the fold keys the highlighted row answers to", async () => {
    const state = allTabWithRecommendations();

    expect(await pickerFrame(state)).toContain("←→ ⇧←→ fold");
    // On a model row only the whole-list keys do anything, and they yield the
    // slot to the row's own keys when the footer runs short.
    expect(await pickerFrame({ ...state, selectedIndex: 1 }, 130))
        .toContain("⇧←→ fold all");
    expect(await pickerFrame({ ...state, selectedIndex: 1 }, 80))
        .not.toContain("⇧←→ fold all");
});

test("a recommended level is not part of the choice, and not on the row", async () => {
    const state = { ...allTabWithRecommendations(), selectedIndex: 1 };

    // Selecting it names the model only. The level pane still follows, which is
    // what makes the row behave the same in either section.
    expect(handleTuiSettingsPickerKey(state, { name: "return" }).selection)
        .toEqual({
            kind: "model",
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
        });
    // The level pane is where a level is chosen, so a row carrying one would
    // read as a setting already made.
    expect(await pickerFrame(state)).not.toContain("medium");
});

test("no model appears twice, because pool membership is a mark on its own row", () => {
    const state = modelPickerWithPool();

    expect(state.allOptions.filter((option) =>
        option.model === "z-ai/glm-5.2"
    )).toHaveLength(1);
    // The same row carries the pool mark and answers on both tabs.
    const glm = state.allOptions.find((option) =>
        option.model === "z-ai/glm-5.2"
    );
    expect(glm?.pooledRank).toBe(1);
});

test("an unprobed pool row keeps its row clean and explains the state", async () => {
    const state = modelPickerWithPool([{
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        available: true,
        verified: false,
        levels: [],
    }], "moonshotai/kimi-k3", "openrouter");
    const frame = await pickerFrame(state);

    expect(state.tab).toBe("pool");
    // The row runs like any other and says nothing about the probe it has not
    // had: the column beside the list carries that. The provider is in that
    // column too.
    expect(frame).toMatch(/GLM-5\.2\s+│/);
    expect(frame).toContain("not probed yet");
    expect(frame).toContain("verify");
    const row = state.options[state.selectedIndex];
    expect(row?.unverified).toBe(true);
    // Enter still applies the model: nothing about the row is a gate.
    expect(handleTuiSettingsPickerKey(state, { name: "return" }).selection)
        .toEqual({
            kind: "model",
            provider: "openrouter",
            model: "z-ai/glm-5.2",
        });
});

test("a verified pool row says so beside its provider", async () => {
    const state = modelPickerWithPool([{
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        available: true,
        verified: true,
        levels: [],
    }]);
    const frame = await pickerFrame(state);

    // Verification and provider are separate facts; probing a row visibly
    // changes it instead of trading one word for the other. The row carries
    // the verification, the pane beside it names the provider.
    // A tick on the row, the word in the facts block above it.
    expect(frame).toMatch(/GLM-5\.2\s+✓/);
    expect(frame).toMatch(/│  Verified\s*\n.*│  answered a live probe/);
});

test("the stacked facts leave most of a wide model pane to model names", async () => {
    const state = modelPickerWithPool([{
        provider: "openrouter",
        model: "openai/gpt-5.3-codex-spark",
        label: "OpenAI: GPT-5.3-Codex-Spark",
        available: true,
        verified: true,
        levels: [],
    }]);
    const frame = await pickerFrame(state, 100);

    expect(frame).toContain("GPT-5.3-Codex-Spark");
    expect(frame).toMatch(/│  Images\s*\n.*│  not known/);
    expect(frame).toMatch(/│  Model ID/);
    expect(frame).toContain("openai/gpt-5.");
});

test("the verify key asks for a probe of the selected pool row", () => {
    const state = modelPickerWithPool([{
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        available: true,
        verified: false,
        levels: [],
    }]);

    const expected = {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
    };
    expect(
        handleTuiSettingsPickerKey(state, { name: "v", ctrl: true })
            .poolVerify,
    ).toEqual(expected);
    expect(handleTuiSettingsPickerKey(
        state,
        { name: "v", ctrl: true, shift: true },
    ).poolVerifySweep).toBe(true);
    // F is reserved for refreshing provider catalogs, never verification.
    expect(handleTuiSettingsPickerKey(state, { name: "f", ctrl: true })
        .poolVerify).toBeUndefined();
    expect(handleTuiSettingsPickerKey(
        state,
        { name: "f", ctrl: true, shift: true },
    ).poolVerify).toBeUndefined();
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
    const searched = updateTuiSettingsPickerSearch(long, "k").state!;
    const frame = await pickerFrame(searched);

    expect(frame).toContain("Kimi K3");
    expect(frame).not.toContain("a description long enough");
    expect(frame).not.toContain("…");
});

test("a search stays inside the tab it was typed on", () => {
    const onPool = modelPickerWithPool();
    const searched = updateTuiSettingsPickerSearch(onPool, "k");

    // kimi is runnable but not pooled, so it has no row on this tab, and a
    // search must not conjure one: the heading says Pool, so the rows under it
    // are the pool.
    expect(searched.state?.options.map((option) => option.model))
        .not.toContain("moonshotai/kimi-k3");

    // Clearing the query drops back to the tab's own list.
    const cleared = updateTuiSettingsPickerSearch(searched.state!, "");
    expect(cleared.state?.options.map((option) => option.model)).toEqual([
        "gpt-5.6-sol",
        "z-ai/glm-5.2",
    ]);
});

test("ctrl+s asks to pool the highlighted model, and to remove a pooled one", () => {
    const state = modelPickerWithPool([], "moonshotai/kimi-k3");
    const kimi = handleTuiSettingsPickerKey(state, { name: "s", ctrl: true });

    expect(kimi.poolToggle).toEqual({
        action: "add",
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
    });
    // The pane does not edit its own list: the row is unchanged until the host
    // answers with a new snapshot.
    expect(kimi.state).toBe(state);

    // The pane opens with the cursor on the running model, so pooling or
    // unpooling it is one key with nothing to aim first.
    const cursor = modelPickerWithPool(
        pooledModels,
        "gpt-5.6-sol",
        "openai-codex",
    );

    expect(cursor.options[cursor.selectedIndex]?.model).toBe("gpt-5.6-sol");
    expect(
        handleTuiSettingsPickerKey(cursor, { name: "s", ctrl: true })
            .poolToggle,
    ).toEqual({
        action: "remove",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
    });
});

test("ctrl+z asks the caller to undo only when a pool change is available", async () => {
    const state = modelPickerWithPool(pooledModels, "gpt-5.6-sol", "openai-codex");
    expect(
        handleTuiSettingsPickerKey(state, { name: "z", ctrl: true })
            .undoPoolChange,
    ).toBeUndefined();

    const undoable = { ...state, canUndoPoolChange: true };
    expect(
        handleTuiSettingsPickerKey(undoable, { name: "z", ctrl: true })
            .undoPoolChange,
    ).toBe(true);
    expect(await pickerFrame(undoable)).toContain("^z undo");

    const synced = syncTuiModelPicker(undoable, {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        availableModels,
        pooled: pooledModels,
    });
    expect(synced.canUndoPoolChange).toBe(true);
});

test("the model picker footer names the action the highlighted row would take", async () => {
    const onPoolRow = modelPickerWithPool(
        pooledModels,
        "gpt-5.6-sol",
        "openai-codex",
    );
    expect(onPoolRow.options[onPoolRow.selectedIndex]?.model)
        .toBe("gpt-5.6-sol");
    expect(await pickerFrame(onPoolRow)).toContain("^s unpin");

    // On a row nobody pooled the same key says the opposite thing.
    const onAll = handleTuiSettingsPickerKey(
        handleTuiSettingsPickerKey(onPoolRow, { name: "tab" }).state!,
        { name: "right", shift: true },
    ).state!;
    const onUnpooledRow = {
        ...onAll,
        selectedIndex: onAll.options.findIndex((option) =>
            option.model === "moonshotai/kimi-k3"
        ),
    };
    expect(onUnpooledRow.options[onUnpooledRow.selectedIndex]?.model)
        .toBe("moonshotai/kimi-k3");
    expect(await pickerFrame(onUnpooledRow)).toContain("^s pin");
});

test("a settings snapshot rebuilds the open pane without moving the cursor", () => {
    const state = modelPickerWithPool([]);
    const highlighted = state.options[state.selectedIndex];
    const synced = syncTuiModelPicker(state, {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        availableModels,
        pooled: pooledModels,
    });

    // A row gained a pool mark above the cursor. The cursor follows the model,
    // not the index.
    expect(synced.options[synced.selectedIndex]?.value)
        .toBe(highlighted?.value);
    expect(synced.allOptions.find((option) =>
        option.model === "z-ai/glm-5.2"
    )?.pooledRank).toBe(1);
});

test("a snapshot leaves the user on the tab they moved to", () => {
    // The tab is the user's own place in the pane, so a rebuild must not drop
    // them back onto the one it opens with mid-action.
    const onAllTab = handleTuiSettingsPickerKey(
        modelPickerWithPool(),
        { name: "tab" },
    ).state!;
    const synced = syncTuiModelPicker(onAllTab, {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        availableModels,
        pooled: pooledModels,
    });

    expect(synced.tab).toBe("all");
    expect(modelRows(synced).map((option) => option.model)).toEqual([
        "z-ai/glm-5.2",
        "moonshotai/kimi-k3",
    ]);
});

test("a snapshot keeps the pane the pane was opened from", () => {
    // Adding a model round-trips through the host and rebuilds this pane. If
    // the rebuild dropped the parent, adding would quietly turn escape from
    // "back to /settings" into "close everything".
    const menu = startTuiSettingsMenu("settings");
    const state = withTuiPickerParent(modelPickerWithPool([]), menu);
    const synced = syncTuiModelPicker(state, {
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        availableModels,
        pooled: pooledModels,
    });

    expect(handleTuiSettingsPickerKey(synced, { name: "escape" }).state)
        .toBe(menu);
    expect(tuiPickerMenuAncestor(synced)).toBe(menu);
});

const PROVIDER_ROWS = [
    {
        id: "openai-codex",
        label: "OpenAI Codex",
        group: "Subscriptions",
        hint: "ChatGPT Plus/Pro subscription",
        connected: true,
    },
    {
        id: "openrouter",
        label: "OpenRouter",
        group: "API keys",
        hint: "API key, pay per token",
        connected: false,
        refreshable: true,
        endpointEditable: true,
    },
    {
        id: "ollama",
        label: "Ollama",
        group: "Local",
        hint: "local, no account",
        connected: true,
        refreshable: true,
        endpointEditable: true,
    },
    {
        id: "gemini",
        label: "gemini",
        group: "Added in config",
        hint: "API key",
        connected: true,
        refreshable: true,
        declared: true,
        endpointEditable: true,
    },
] as const;

test("an empty declared provider can still ask for its model list", () => {
    const pane = startTuiProviderPicker([{
        id: "empty-gateway",
        label: "Empty gateway",
        group: "Added in config",
        connected: true,
        refreshable: true,
        declared: true,
    }]);

    expect(handleTuiSettingsPickerKey(pane, { name: "f", ctrl: true }))
        .toMatchObject({ handled: true, refreshCatalog: "empty-gateway" });
});

test("the connect pane groups providers by access and spells out connected status", async () => {
    const pane = withTuiPickerParent(
        startTuiProviderPicker(PROVIDER_ROWS),
        modelPickerWithPool(),
    );
    const frame = await pickerFrame(pane, 151, 36);

    expect(frame).toContain("Select model");
    expect(frame).toContain("Providers ^e");
    expect(frame).toContain("Subscriptions");
    expect(frame).toContain("API keys");
    expect(frame).toContain("Local");
    expect(frame).toContain("Added in config");
    expect(frame).toMatch(/OpenAI Codex.*connected/);
    expect(frame).toMatch(/Ollama.*connected/);
    expect(frame).not.toMatch(/OpenRouter.*connected/);
    expect(frame).not.toContain("✓");
    expect(frame).toMatch(/›\s+OpenRouter/);
    // The credential is on the row, so choosing one is not a surprise about
    // what it is going to ask for.
    expect(frame).toContain("ChatGPT Plus/Pro subscription");
    expect(frame).toContain("API key, pay per token");
    expect(frame).toContain("⇥ tabs · esc back");
});

test("provider access facts map to stable TUI groups", () => {
    expect(tuiProviderGroup("subscription")).toBe("Subscriptions");
    expect(tuiProviderGroup("api_key")).toBe("API keys");
    expect(tuiProviderGroup("local")).toBe("Local");
    expect(tuiProviderGroup("api_key", true)).toBe("Added in config");
});

test("provider groups have a stable order and preserve order within a group", () => {
    const cerebras = {
        id: "cerebras",
        label: "Cerebras",
        group: "API keys" as const,
        connected: false,
    };
    const pane = startTuiProviderPicker([
        PROVIDER_ROWS[2],
        PROVIDER_ROWS[1],
        PROVIDER_ROWS[3],
        PROVIDER_ROWS[0],
        cerebras,
    ]);

    expect(pane.allOptions.filter((option) => option.action !== true)
        .map((option) => option.value)).toEqual([
            "openai-codex",
            "openrouter",
            "cerebras",
            "ollama",
            "gemini",
        ]);
});

test("the provider marker moves independently of connected status", async () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);
    const first = await pickerFrame(pane, 151, 36);
    expect(first).toMatch(/›\s+OpenRouter/);
    expect(first).not.toMatch(/›\s+Ollama/);

    const moved = handleTuiSettingsPickerKey(pane, { name: "down" }).state!;
    const second = await pickerFrame(moved, 151, 36);
    expect(second).toMatch(/›\s+Ollama/);
    expect(second).not.toMatch(/›\s+OpenRouter/);
    expect(second).toMatch(/Ollama.*connected/);
});

test("provider search keeps matching group headings in group order", async () => {
    const start = startTuiProviderPicker(PROVIDER_ROWS);
    const pane = updateTuiSettingsPickerSearch(start, "open").state!;

    expect(pane.options.map((option) => option.value)).toEqual([
        "openai-codex",
        "openrouter",
        TUI_DECLARE_PROVIDER_VALUE,
    ]);
    const frame = await pickerFrame(pane, 151, 36);
    expect(frame.indexOf("Subscriptions"))
        .toBeLessThan(frame.indexOf("API keys"));
    expect(frame).not.toContain("Local");
    expect(frame).not.toContain("Added in config");
});

test("the connect pane opens on the first provider still to be connected", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);

    expect(pane.options[pane.selectedIndex]?.value).toBe("openrouter");
    expect(handleTuiSettingsPickerKey(pane, { name: "enter" }).selection)
        .toEqual({ kind: "provider", providerId: "openrouter" });
});

test("delete on the connect pane names the row to forget", () => {
    // Whether there is a stored credential behind the row is a fact about the
    // disk, so the pane reports the row and the client that can read it answers.
    const pane = startTuiProviderPicker(PROVIDER_ROWS);
    const connected = { ...pane, selectedIndex: 0 };

    const transition = handleTuiSettingsPickerKey(connected, {
        name: "delete",
    });

    expect(transition.handled).toBe(true);
    expect(transition.forgetProvider).toBe("openai-codex");
    // The pane stays put: the caller reopens it once the store has changed.
    expect(transition.state).toBe(connected);
});

test("the connect pane offers forgetting only on a connected row", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);

    expect(pickerFooter({ ...pane, selectedIndex: 0 })).toContain("del forget");
    expect(pickerFooter({ ...pane, selectedIndex: 1 }))
        .not.toContain("del forget");
});

test("the declare row is last on the connect pane and is not a provider", async () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);

    const last = pane.options[pane.options.length - 1];
    expect(last?.value).toBe(TUI_DECLARE_PROVIDER_VALUE);
    expect(last?.action).toBe(true);
    // Nothing that counts providers counts it, and it carries no connected
    // mark: it names a thing to do, not a provider to sign in to.
    expect(pane.options.filter((option) => option.action !== true))
        .toHaveLength(PROVIDER_ROWS.length);
    expect(last?.connected).toBeUndefined();
    expect(pane.selectedIndex).toBe(1);

    const frame = await pickerFrame(pane);
    expect(frame).toContain("Declare a provider…");
    // It sits below the groups without inventing one of its own.
    expect(frame).not.toContain("Other");
});

test("⏎ on the declare row asks for the same form the chord asks for", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);
    const onDeclare = { ...pane, selectedIndex: pane.options.length - 1 };

    const transition = handleTuiSettingsPickerKey(onDeclare, { name: "enter" });

    expect(transition.handled).toBe(true);
    expect(transition.declareProvider).toBe(true);
    expect(transition.selection).toBeUndefined();
    expect(pickerFooter(onDeclare)).toContain("⏎ declare");
});

test("the connect pane can open on a named row", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS, {
        selected: "ollama",
    });

    expect(pane.options[pane.selectedIndex]?.value).toBe("ollama");
});

test("a row the pane cannot find falls back to the first unconnected one", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS, { selected: "gone" });

    expect(pane.options[pane.selectedIndex]?.value).toBe("openrouter");
});

test("the connect pane carries a line the caller needs it to say", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS, {
        selected: "openai-codex",
        subtitle: "OpenAI Codex has no stored credential to forget",
    });

    expect(pane.subtitle).toBe(
        "OpenAI Codex has no stored credential to forget",
    );
    expect(pane.options[pane.selectedIndex]?.value).toBe("openai-codex");
});

test("the declare row offers its action once", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);
    const onDeclare = { ...pane, selectedIndex: pane.options.length - 1 };

    const footer = pickerFooter(onDeclare);
    expect(footer).toContain("⏎ declare");
    expect(footer.split("declare")).toHaveLength(2);
    // The chord still reads on a row that does not offer ⏎ declare.
    expect(pickerFooter(pane)).toContain(tuiKeyHint("declare_provider"));
});

test("delete on the declare row asks to forget nothing", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);
    const onDeclare = { ...pane, selectedIndex: pane.options.length - 1 };

    const transition = handleTuiSettingsPickerKey(onDeclare, { name: "delete" });

    expect(transition.handled).toBe(true);
    expect(transition.forgetProvider).toBeUndefined();
    expect(pickerFooter(onDeclare)).not.toContain("del forget");
});

test("the declare row survives a search that matches no provider", async () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);

    const filtered = updateTuiSettingsPickerSearch(pane, "zzz").state!;

    // A search that found nothing is exactly when declaring is the next thing
    // to do, so the row stays and stays last.
    expect(filtered.options.map((option) => option.value))
        .toEqual([TUI_DECLARE_PROVIDER_VALUE]);
    const frame = await pickerFrame(filtered, 151, 36);
    expect(frame).toMatch(/›\s+Declare a provider/);
    expect(frame).not.toContain("›+");
    expect(frame).not.toMatch(/\+\s+Declare a provider/);
    expect(handleTuiSettingsPickerKey(filtered, { name: "enter" })
        .declareProvider).toBe(true);
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

test("the connect pane opened from the model pane draws in the same card", async () => {
    const providers = withTuiPickerParent(
        startTuiProviderPicker(PROVIDER_ROWS),
        modelPickerWithPool(),
    );

    const frame = await pickerFrame(providers);

    // Same title, same tab strip: one card that changes what it lists, so the
    // strip the user tabbed along is still there to tab back on.
    expect(frame).toContain("Select model");
    expect(frame).not.toContain("Connect a provider");
    expect(frame).toMatch(
        /Shortlist \(2\)\s+All \(\d+\)\s+Actions\s+Defaults\s+Help\s+Providers \^e/,
    );
    expect(frame).toContain("^f refresh");
    expect(frame).toContain("OpenRouter");
});

test("⇥ walks from the last tab onto the connect pane and back off it", () => {
    const help = switchedModelTab(modelPickerWithPool(), "help");

    const onto = handleTuiSettingsPickerKey(help, { name: "tab" });
    expect(onto.openProviders).toBe(true);
    // The list under the pane wraps, so leaving it does not drop the user back
    // on the stop that opened it.
    expect(onto.state?.kind).toBe("model");
    expect((onto.state as TuiSettingsPickerState).tab).toBe("pool");

    const providers = withTuiPickerParent(
        startTuiProviderPicker(PROVIDER_ROWS),
        onto.state as TuiSettingsPickerState,
    );
    const off = handleTuiSettingsPickerKey(providers, { name: "tab" });
    expect(off.handled).toBe(true);
    expect(off.state).toBe(onto.state);
});

test("shift+tab walks left across model tabs and the providers pane", () => {
    const all = switchedModelTab(modelPickerWithPool(), "all");
    const pool = handleTuiSettingsPickerKey(all, {
        name: "tab",
        shift: true,
    });
    expect((pool.state as TuiSettingsPickerState).tab).toBe("pool");

    const ontoProviders = handleTuiSettingsPickerKey(pool.state!, {
        name: "tab",
        shift: true,
    });
    expect(ontoProviders.openProviders).toBe(true);
    expect((ontoProviders.state as TuiSettingsPickerState).tab).toBe("help");

    const providers = withTuiPickerParent(
        startTuiProviderPicker(PROVIDER_ROWS),
        ontoProviders.state as TuiSettingsPickerState,
    );
    const help = handleTuiSettingsPickerKey(providers, {
        name: "tab",
        shift: true,
    });
    expect((help.state as TuiSettingsPickerState).tab).toBe("help");
});

test("the wheel moves the cursor, so enter still means the row on screen", () => {
    // The pane windows itself around selectedIndex. A wheel that slid the
    // window on its own would leave the highlight off screen, pointing at
    // something the user can no longer see.
    const state = modelPickerWithPool();
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
    }).state?.selectedIndex).toBe(
        Math.max(0, down.state!.selectedIndex - 3),
    );
});

test("the wheel stops at both ends and ignores a sideways scroll", () => {
    const state = modelPickerWithPool();

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
    expect(handleTuiSettingsPickerScroll(modelPickerWithPool(), {
        direction: "down",
        delta: 0.2,
    }).state?.selectedIndex).toBe(1);
});

test("the pane names the half-page keys where it names the others", async () => {
    // ctrl+d and ctrl+u are unfindable otherwise: nothing on screen says a
    // pane responds to them.
    expect(await pickerFrame(modelPickerWithPool())).toContain("^d^u move");
});

test("a level listed twice is offered once", () => {
    const state = startTuiReasoningPicker(
        [
            { id: "high", label: "Extra High" },
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
        ],
        undefined,
        "high",
    );

    expect(state.options.map((option) => option.value)).toEqual([
        "high",
        "low",
    ]);
    expect(state.options[0]?.label).toBe("Extra High");
});

test("choosing a model closes the pane, choosing a theme goes back to the menu", () => {
    const menu = startTuiSettingsMenu("settings");
    const modelPane = withTuiPickerParent(
        startTuiSettingsPicker("model", undefined, undefined, undefined),
        menu,
    );

    // Applying a model starts work that streams into the transcript, and a
    // modal left open would sit in front of it.
    expect(tuiPickerAfterSelection(
        { kind: "model", provider: "openrouter", model: "moonshotai/kimi-k3" },
        modelPane,
    )).toBeUndefined();
    const themePane = withTuiPickerParent(
        startTuiSettingsPicker("theme", undefined, undefined, "default"),
        menu,
    );
    expect(tuiPickerAfterSelection({ kind: "theme", theme: "orng" }, themePane))
        .toBe(menu);
});

test("pooling a row refreshes the open pane from the snapshot that comes back", () => {
    const state = handleTuiSettingsPickerKey(
        modelPickerWithPool([]),
        { name: "s", ctrl: true },
    );

    expect(state.state?.tab).toBe("all");
    expect(state.poolToggle).toEqual({
        action: "add",
        provider: "openrouter",
        model: "z-ai/glm-5.2",
    });

    const pooled = [{
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        available: true,
        verified: false,
        levels: [],
    }] as const;
    const synced = syncTuiModelPicker(state.state!, {
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        availableModels,
        pooled,
    });

    // The row is pooled now, so ^s on it offers to take it back out.
    expect(synced.options[synced.selectedIndex]).toMatchObject({
        model: "z-ai/glm-5.2",
        pooledRank: 0,
    });
    expect(pickerFooter(synced)).toContain("unpin");
});

test("the footer sheds whole hints rather than splitting a chord from its label", () => {
    const state = modelPickerWithPool();
    const full = pickerFooter(state);
    const narrow = pickerFooter(state, 46);

    expect(full.length).toBeGreaterThan(narrow.length);
    expect(narrow.length).toBeLessThanOrEqual(46);
    for (const hint of narrow.split(" · ")) {
        expect(full).toContain(hint);
    }
    // Moving, choosing and leaving are what the pane is for, so they are the
    // last hints to go.
    expect(narrow).toContain("close");
});

test("ctrl+n asks to name a pooled row and does nothing on an unpooled one", () => {
    const pooled = modelPickerWithPool(
        pooledModels,
        "gpt-5.6-sol",
        "openai-codex",
    );

    expect(handleTuiSettingsPickerKey(pooled, { name: "n", ctrl: true }))
        .toEqual({
            state: pooled,
            handled: true,
            poolName: {
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                label: "gpt-5.6-sol",
            },
        });

    const unpooled = modelPickerWithPool([], "moonshotai/kimi-k3");
    const refused = handleTuiSettingsPickerKey(unpooled, {
        name: "n",
        ctrl: true,
    });

    expect(refused.poolName).toBeUndefined();
    expect(refused.handled).toBe(true);
});

test("a named pool row reads by its name and keeps the model id on the row", async () => {
    const named = modelPickerWithPool(
        pooledModels.map((entry) =>
            entry.model === "gpt-5.6-sol"
                ? { ...entry, poolName: "frosty" }
                : entry
        ),
        "gpt-5.6-sol",
        "openai-codex",
    );
    const frame = await pickerFrame(named);

    expect(named.options[named.selectedIndex]?.label).toBe("frosty");
    expect(frame).toContain("frosty");
    expect(frame).toContain("gpt-5.6-sol");
    // Searching still finds the row by what the model is called.
    expect(named.options[named.selectedIndex]?.searchText)
        .toContain("gpt-5.6-sol");
});

test("the inspector offers naming on a pooled row only", async () => {
    const pooled = modelPickerWithPool(
        pooledModels,
        "gpt-5.6-sol",
        "openai-codex",
    );
    expect(await pickerFrame(pooled)).toMatch(/Name this model\s+\^n/);

    const unpooled = modelPickerWithPool([], "moonshotai/kimi-k3");
    expect(await pickerFrame(unpooled)).not.toContain("Name this model");
});

test("an old session stays on the relative clock instead of a calendar date", async () => {
    const state = startTuiSessionPicker([
        {
            ...session("ancient", "idle"),
            title: "Left alone for weeks",
            updated_at: "2026-06-12T21:00:00.000Z",
        },
    ], undefined, false, new Date("2026-07-20T21:00:00.000Z"));

    const rendered = await pickerFrame(state);
    expect(rendered).toContain("38d ago");
    expect(rendered).not.toContain("Jun");
});

test("a session row reports its transcript size beside the workspace", async () => {
    const state = startTuiSessionPicker([
        {
            ...session("small", "idle"),
            title: "Barely started",
            size_bytes: 4_200,
        },
        {
            ...session("large", "idle"),
            title: "Ran for weeks",
            size_bytes: 3_500_000,
        },
        {
            ...session("gone", "idle"),
            title: "File went missing",
        },
    ], undefined, false, new Date("2026-07-20T21:00:00.000Z"));

    const rows = (await pickerFrame(state)).split("\n");
    const rowFor = (title: string): string =>
        rows.find((line) => line.includes(title)) ?? "";
    expect(rowFor("Barely started")).toContain("4K");
    expect(rowFor("Ran for weeks")).toContain("3.5M");
    // An unstattable session still lists, with the workspace column alone.
    expect(rowFor("File went missing")).not.toBe("");
    expect(rowFor("File went missing")).not.toMatch(/\d[BKM]\s/);
});

test("the reviewer menu shows what each slot resolves to", () => {
    const unset = startTuiReviewerMenu();
    expect(unset.options.map((option) => option.description)).toEqual([
        "the agent's own model",
        "not set",
    ]);

    const set = startTuiReviewerMenu({
        mode: "fixed",
        primary: { provider: "openrouter", model: "haiku" },
        fallback: { model: "sonnet" },
    });
    expect(set.options.map((option) => option.description)).toEqual([
        "haiku · openrouter",
        "sonnet",
    ]);
});

test("the reviewer picker offers a clear row above every pooled model", () => {
    const pooled = [
        {
            provider: "openrouter",
            model: "haiku",
            label: "Haiku",
            available: true,
            verified: true,
        },
    ] as unknown as readonly PooledModel[];
    const picker = startTuiReviewerPicker("fallback", pooled, {
        provider: "openrouter",
        model: "haiku",
    });

    expect(picker.options.map((option) => option.value)).toEqual([
        REVIEWER_CLEAR_VALUE,
        "openrouter/haiku",
    ]);
    expect(picker.selectedIndex).toBe(1);
    expect(handleTuiSettingsPickerKey(picker, { name: "enter" }).selection)
        .toEqual({
            kind: "reviewer",
            slot: "fallback",
            provider: "openrouter",
            model: "haiku",
        });
});

test("choosing the clear row returns the slot with no model", () => {
    const picker = startTuiReviewerPicker("primary");
    expect(handleTuiSettingsPickerKey(picker, { name: "enter" }).selection)
        .toEqual({ kind: "reviewer", slot: "primary" });
});

test("ctrl+shift+n on the connect pane asks for the declaration form", () => {
    // The form ends in a write to config.json, so the pane reports the request
    // and the client that owns the file answers.
    const pane = startTuiProviderPicker(PROVIDER_ROWS);

    const transition = handleTuiSettingsPickerKey(pane, {
        name: "n",
        ctrl: true,
        shift: true,
    });

    expect(transition.handled).toBe(true);
    expect(transition.declareProvider).toBe(true);
    expect(transition.state).toBe(pane);
});

test("the connect pane offers declaring on every row", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS);

    expect(pickerFooter({ ...pane, selectedIndex: 0 })).toContain("declare");
    expect(pickerFooter({ ...pane, selectedIndex: 1 })).toContain("declare");
});

test("the declaration form opens on the name, ready to type", () => {
    const form = startTuiProviderForm();

    expect(form.field).toBe("id");
    expect(form.id).toBe("");
    expect(form.protocol).toBe("openai-chat");
    expect(form.credential).toBe("api_key");
});

test("provider text fields use the native editor cursor", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiProviderFormView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    let form = startTuiProviderForm();
    view.update(form);
    view.focus();
    try {
        for (const character of "gateway") {
            form = view.handleKey(form, {
                name: character,
                sequence: character,
            }).state!;
            view.update(form);
        }
        form = view.handleKey(form, { name: "left" }).state!;
        form = view.handleKey(form, { name: "left" }).state!;
        form = view.handleKey(form, { name: "x", sequence: "x" }).state!;
        view.update(form);
        expect(form.id).toBe("gatewxay");

        form = view.handleKey(form, { name: "down" }).state!;
        view.update(form);
        expect(setup.renderer.currentFocusedRenderable?.id)
            .toBe("provider-form-id-editor");
        view.focus();
        expect(setup.renderer.currentFocusedRenderable?.id)
            .toBe("provider-form-base_url-editor");
        form = view.handleKey(form, { name: "h", sequence: "h" }).state!;
        view.update(form);

        expect(form.field).toBe("base_url");
        expect(form.baseUrl).toBe("h");
        expect(setup.renderer.currentFocusedRenderable?.id)
            .toBe("provider-form-base_url-editor");
        expect(view.box.findDescendantById("provider-form-base_url-editor"))
            .toBeInstanceOf(TextareaRenderable);
    } finally {
        setup.renderer.destroy();
    }
});

test("the choice fields toggle rather than take text", () => {
    let form = startTuiProviderForm();
    form = { ...form, field: "protocol" };
    form = handleTuiProviderFormKey(form, { name: "right" }).state!;
    expect(form.protocol).toBe("anthropic-messages");

    form = { ...form, field: "credential" };
    form = handleTuiProviderFormKey(form, { name: "space" }).state!;
    expect(form.credential).toBe("none");

    const typed = handleTuiProviderFormKey(form, { name: "x", sequence: "x" });
    expect(typed.handled).toBe(true);
    expect(typed.state?.credential).toBe("none");
});

test("a paste lands in the focused text field", () => {
    const form = handleTuiProviderFormPaste(
        { ...startTuiProviderForm(), field: "base_url" },
        "https://gateway.example/v1\n",
    );

    expect(form.baseUrl).toBe("https://gateway.example/v1");
});

test("a finished form submits the declaration", () => {
    const form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "gateway",
        baseUrl: "https://gateway.example/v1",
        field: "credential",
    };

    const transition = handleTuiProviderFormKey(form, { name: "enter" });

    expect(transition.state).toBeUndefined();
    expect(transition.submitted).toEqual({
        id: "gateway",
        declaration: {
            protocol: "openai-chat",
            base_url: "https://gateway.example/v1",
            credential: "api_key",
        },
    });
});

test("an id Vera already ships is refused in the form", () => {
    const form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "openrouter",
        baseUrl: "https://gateway.example/v1",
    };

    const transition = handleTuiProviderFormKey(form, { name: "enter" });

    expect(transition.submitted).toBeUndefined();
    expect(transition.state?.field).toBe("id");
    expect(transition.state?.error).toContain("openrouter");
});

test("a provider id that is not a safe lowercase slug is refused", () => {
    const form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "./../../config",
        baseUrl: "https://gateway.example/v1",
    };

    const transition = handleTuiProviderFormKey(form, { name: "enter" });

    expect(transition.submitted).toBeUndefined();
    expect(transition.state?.field).toBe("id");
    expect(transition.state?.error).toContain("lowercase letters");
});

test("an empty base URL is refused and lands the cursor on it", () => {
    const form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "gateway",
    };

    const transition = handleTuiProviderFormKey(form, { name: "enter" });

    expect(transition.submitted).toBeUndefined();
    expect(transition.state?.field).toBe("base_url");
});

test("editing clears a refusal", () => {
    const refused: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "openrouter",
        error: "openrouter is a provider Vera ships",
    };

    const transition = handleTuiProviderFormKey(refused, {
        name: "x",
        sequence: "x",
    });

    expect(transition.state?.error).toBeUndefined();
});

test("escape closes the form without a declaration", () => {
    const transition = handleTuiProviderFormKey(startTuiProviderForm(), {
        name: "escape",
    });

    expect(transition.handled).toBe(true);
    expect(transition.state).toBeUndefined();
    expect(transition.submitted).toBeUndefined();
});

const providerFormRowText = (row: StyledText | undefined): string =>
    (row?.chunks ?? []).map((chunk) => chunk.text).join("");

test("the form draws a key row while the credential is a key", () => {
    const rows = tuiProviderFormRows({
        ...startTuiProviderForm(),
        id: "gateway",
        baseUrl: "https://gateway.example/v1",
    });

    expect(rows).toHaveLength(5);
    expect(providerFormRowText(rows[0])).toContain("gateway");
    expect(providerFormRowText(rows[1])).toContain(
        "https://gateway.example/v1",
    );
    expect(providerFormRowText(rows[2])).toContain("OpenAI chat");
    expect(providerFormRowText(rows[3])).toContain("API key");
    expect(providerFormRowText(rows[3])).toContain("No key");
    expect(providerFormRowText(rows[4])).toContain("Key");
});

test("the credential row marks both choices without color", () => {
    let form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        field: "credential",
    };
    let row = providerFormRowText(tuiProviderFormRows(form)[3]);
    expect(row).toContain("● API key");
    expect(row).toContain("○ No key");

    form = handleTuiProviderFormKey(form, { name: "right" }).state!;
    row = providerFormRowText(tuiProviderFormRows(form)[3]);
    expect(row).toContain("○ API key");
    expect(row).toContain("● No key");
});

test("the provider form visibly offers no-key authentication", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiProviderFormView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    let form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "outrider",
        baseUrl: "http://127.0.0.1:11435/v1",
        field: "credential",
    };
    view.update(form);
    view.focus();
    try {
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("› Credential  ● API key   ○ No key");
        expect(frame).toContain("←→ change");

        form = view.handleKey(form, { name: "right" }).state!;
        view.update(form);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("› Credential  ○ API key   ● No key");
        expect(frame).not.toContain("Key           paste or type");
    } finally {
        setup.renderer.destroy();
    }
});

test("the key row leaves the form when the credential does", () => {
    let form = startTuiProviderForm();
    expect(tuiProviderFormFields(form)).toContain("api_key");

    form = { ...form, field: "credential" };
    form = handleTuiProviderFormKey(form, { name: "space" }).state!;

    expect(form.credential).toBe("none");
    expect(tuiProviderFormFields(form)).not.toContain("api_key");
    expect(tuiProviderFormRows(form)).toHaveLength(4);

    form = handleTuiProviderFormKey(form, { name: "space" }).state!;
    expect(tuiProviderFormFields(form)).toContain("api_key");
});

test("the entered key is drawn in the clear while it is being edited", () => {
    let form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        field: "api_key",
    };
    form = handleTuiProviderFormPaste(form, "sk-live-secret");

    expect(form.apiKey).toBe("sk-live-secret");
    // A paste that arrived short has to be visible while it can still be
    // fixed, which dots would hide.
    const drawn = tuiProviderFormRows(form).map(providerFormRowText).join("\n");
    expect(drawn).toContain("sk-live-secret");
    expect(drawn).not.toContain("•");
});

test("an empty field draws its placeholder softened, not as a value", () => {
    const name = tuiProviderFormRows(startTuiProviderForm())[0]!;

    expect(providerFormRowText(name)).toContain("my-endpoint");
    const placeholder = name.chunks.find((chunk) =>
        chunk.text.includes("my-endpoint")
    );
    expect(placeholder?.attributes ?? 0).not.toBe(0);
    const filled = tuiProviderFormRows({
        ...startTuiProviderForm(),
        id: "gateway",
    })[0]!;
    const value = filled.chunks.find((chunk) => chunk.text.includes("gateway"));
    expect(value?.attributes ?? 0).toBe(0);
});

test("turning the credential off drops the key that was typed", () => {
    let form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        apiKey: "sk-live-secret",
        field: "credential",
    };
    form = handleTuiProviderFormKey(form, { name: "space" }).state!;

    expect(form.apiKey).toBe("");
});

test("tab and shift+tab walk the fields and wrap both ways", () => {
    let form = startTuiProviderForm();
    const seen: string[] = [];
    for (let step = 0; step < 5; step += 1) {
        form = handleTuiProviderFormKey(form, { name: "tab" }).state!;
        seen.push(form.field);
    }

    expect(seen).toEqual([
        "base_url",
        "protocol",
        "credential",
        "api_key",
        "id",
    ]);

    form = handleTuiProviderFormKey(form, { name: "tab", shift: true }).state!;
    expect(form.field).toBe("api_key");
    form = handleTuiProviderFormKey(form, { name: "backtab" }).state!;
    expect(form.field).toBe("credential");
});

test("tab skips the hidden key field", () => {
    let form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        credential: "none",
        field: "credential",
    };
    form = handleTuiProviderFormKey(form, { name: "tab" }).state!;

    expect(form.field).toBe("id");
});

test("a refused save keeps every other typed value and names the field", () => {
    const form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "gateway",
        apiKey: "sk-live-secret",
        field: "api_key",
    };

    const transition = handleTuiProviderFormKey(form, { name: "enter" });

    expect(transition.submitted).toBeUndefined();
    expect(transition.state?.field).toBe("base_url");
    expect(transition.state?.error).toContain("base URL");
    expect(transition.state?.error).not.toContain("sk-live-secret");
    expect(transition.state?.id).toBe("gateway");
    expect(transition.state?.apiKey).toBe("sk-live-secret");
});

test("a filled form submits the declaration and the key together", () => {
    const form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "gateway",
        baseUrl: "https://gateway.example/v1",
        apiKey: "sk-live-secret",
        field: "api_key",
    };

    const transition = handleTuiProviderFormKey(form, { name: "enter" });

    expect(transition.state).toBeUndefined();
    expect(transition.submitted).toEqual({
        id: "gateway",
        declaration: {
            protocol: "openai-chat",
            base_url: "https://gateway.example/v1",
            credential: "api_key",
        },
        apiKey: "sk-live-secret",
    });
});

test("a keyless declaration submits without a key", () => {
    const form: TuiProviderFormState = {
        ...startTuiProviderForm(),
        id: "gateway",
        baseUrl: "https://gateway.example/v1",
        credential: "none",
    };

    const transition = handleTuiProviderFormKey(form, { name: "enter" });

    expect(transition.submitted?.apiKey).toBeUndefined();
});


test("opening a declared row edits it, and a shipped row still connects", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS, { selected: "gemini" });

    const edit = handleTuiSettingsPickerKey(pane, { name: "return" });
    expect("editProvider" in edit ? edit.editProvider : undefined)
        .toBe("gemini");
    expect(pickerFooter(pane)).toContain("⏎ edit");

    const shipped = handleTuiSettingsPickerKey(
        { ...pane, selectedIndex: 0 },
        { name: "return" },
    );
    expect("editProvider" in shipped ? shipped.editProvider : undefined)
        .toBeUndefined();
});

test("a shipped row's endpoint opens on the chord, and Codex's does not", () => {
    const pane = startTuiProviderPicker(PROVIDER_ROWS, { selected: "ollama" });
    const chord = { name: "r", ctrl: true };

    const moved = handleTuiSettingsPickerKey(pane, chord);
    expect("editEndpoint" in moved ? moved.editEndpoint : undefined)
        .toBe("ollama");
    expect(pickerFooter(pane)).toContain("endpoint");

    // A declared row's endpoint is already what ⏎ opens, so the chord lands on
    // the same form rather than a second one.
    const declared = handleTuiSettingsPickerKey(
        startTuiProviderPicker(PROVIDER_ROWS, { selected: "gemini" }),
        chord,
    );
    expect("editProvider" in declared ? declared.editProvider : undefined)
        .toBe("gemini");

    const fixed = startTuiProviderPicker(PROVIDER_ROWS, {
        selected: "openai-codex",
    });
    const refused = handleTuiSettingsPickerKey(fixed, chord);
    expect("editEndpoint" in refused ? refused.editEndpoint : undefined)
        .toBeUndefined();
    expect(pickerFooter(fixed)).not.toContain("endpoint");
});

test("a shipped provider's form asks for the endpoint and the key, nothing else", () => {
    const form = startTuiProviderForm(undefined, {
        id: "cerebras",
        baseUrl: "https://api.cerebras.ai/v1",
        protocol: "openai-chat",
        credential: "api_key",
        shipped: true,
    });

    expect(tuiProviderFormFields(form)).toEqual(["base_url", "api_key"]);

    const saved = handleTuiProviderFormKey(
        { ...form, baseUrl: "https://eu.cerebras.example/v1" },
        { name: "return" },
    );
    // The name is a provider Vera ships, which the declaration form refuses
    // and this one is for.
    expect(saved.submitted?.id).toBe("cerebras");
    expect(saved.submitted?.shipped).toBe(true);
    expect(saved.submitted?.declaration.base_url)
        .toBe("https://eu.cerebras.example/v1");

    // An emptied URL is the way back to the host Vera ships, which a shipped
    // provider always has and a declared one never does.
    const restored = handleTuiProviderFormKey(
        { ...form, baseUrl: "" },
        { name: "return" },
    );
    expect(restored.submitted?.restore).toBe(true);
});

test("the edit form opens filled in and a rename says what it replaces", () => {
    const form = startTuiProviderForm(undefined, {
        id: "gemini",
        baseUrl: "https://example.test/v1",
        protocol: "openai-chat",
        credential: "api_key",
        apiKey: "stored-key",
    });

    // The cursor skips the name, since the field a user came to change is the
    // one they could not reach before.
    expect(form.field).toBe("base_url");
    expect(form.editing).toBe("gemini");

    const saved = handleTuiProviderFormKey(form, { name: "return" });
    expect(saved.submitted?.id).toBe("gemini");
    expect(saved.submitted?.apiKey).toBe("stored-key");
    expect(saved.submitted?.replaces).toBeUndefined();

    const renamed = handleTuiProviderFormKey(
        { ...form, id: "gemini-eu" },
        { name: "return" },
    );
    expect(renamed.submitted?.id).toBe("gemini-eu");
    expect(renamed.submitted?.replaces).toBe("gemini");
});

test("the defaults pane offers a way to the collection it draws from", () => {
    const pane = startTuiModelAssignmentPicker("extra", "Extra", "the heaviest job", []);
    // Nothing kept yet is the case that used to dead-end: one row that unsets
    // the default, and nothing saying where a model would come from.
    const browse = pane.options.at(-1);
    expect(browse?.value).toBe(MODEL_ASSIGNMENT_BROWSE_VALUE);
    const selected = handleTuiSettingsPickerKey(
        { ...pane, selectedIndex: pane.options.length - 1 },
        { name: "enter" },
    ).selection;
    expect(selected).toEqual({ kind: "model_assignment_browse" });
});

test("the compaction picker marks the bound model as assigned", async () => {
    const assignedRef = "openai-codex/gpt-5.6-sol";
    const pane = startTuiModelAssignmentPicker(
        "compaction",
        "compaction",
        "summarising a session that has run long",
        pooledModels,
        [assignedRef],
    );
    expect(pane.options.find((option) => option.value === assignedRef))
        .toMatchObject({
            description: "openai-codex",
            rowMeta: [{ text: "assigned 1", tone: "positive" }],
        });
    const frame = await pickerFrame(pane);
    expect(frame).toContain("assigned 1");
});

test("the subagent picker separates assigned, available, and parent fallback", async () => {
    const assignedRef = "openai-codex/gpt-5.6-sol";
    const availableRef = "openrouter/z-ai/glm-5.2";
    const parentRef = "openrouter/google/gemini-3.1-pro-preview";
    const pane = startTuiModelAssignmentPicker(
        "subagents",
        "subagents",
        "delegated work",
        pooledModels,
        [assignedRef],
        false,
        { provider: "openrouter", model: "google/gemini-3.1-pro-preview" },
    );

    expect(pane.title).toBe("Subagent models");
    expect(pane.options.some((option) => option.label === "Not set")).toBe(false);
    expect(pane.options.find((option) => option.value === assignedRef))
        .toMatchObject({
            label: "1. GPT-5.6-Sol",
            group: "Assigned · fallback order",
        });
    expect(pane.options.find((option) => option.value === availableRef))
        .toMatchObject({ group: "Available from Shortlist" });
    expect(pane.options.find((option) =>
        option.value === MODEL_ASSIGNMENT_SELF_VALUE))
        .toMatchObject({
            label: "Spawning session model",
            description: "off",
            card: true,
            rowMeta: `currently ${parentRef}`,
            group: "Parent model fallback",
        });

    const frame = await pickerFrame(pane);
    expect(frame).toContain("Assigned · fallback order");
    expect(frame).toContain("Available from Shortlist");
    expect(frame).toContain("Parent model fallback");
    expect(frame).toContain(`currently ${parentRef}`);
    expect(frame).not.toContain("currently openrouter/google/…");
    expect(frame).not.toContain("Search");
});

test("p toggles subagent assignment without turning into search text", () => {
    const assignedRef = "openai-codex/gpt-5.6-sol";
    const pane = startTuiModelAssignmentPicker(
        "subagents",
        "subagents",
        "delegated work",
        pooledModels,
        [assignedRef],
        false,
        { provider: "openrouter", model: "z-ai/glm-5.2" },
    );

    const remove = handleTuiSettingsPickerKey(pane, { name: "p" });
    expect(remove.selection).toEqual({
        kind: "model_assignment",
        assignment: "subagents",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        remove: true,
    });
    expect(remove.state?.query).toBe("");
    expect(pickerFooter(pane)).toContain("p remove");

    const availableIndex = pane.options.findIndex((option) =>
        option.value === "openrouter/z-ai/glm-5.2");
    const addPane = { ...pane, selectedIndex: availableIndex };
    expect(handleTuiSettingsPickerKey(addPane, { name: "p" }).selection)
        .toEqual({
            kind: "model_assignment",
            assignment: "subagents",
            provider: "openrouter",
            model: "z-ai/glm-5.2",
            acceptDefaultReasoning: true,
        });
    expect(pickerFooter(addPane)).toContain("p assign");

    const parentIndex = pane.options.findIndex((option) =>
        option.value === MODEL_ASSIGNMENT_SELF_VALUE);
    expect(handleTuiSettingsPickerKey(
        { ...pane, selectedIndex: parentIndex },
        { name: "p" },
    ).selection).toEqual({
        kind: "model_assignment",
        assignment: "subagents",
        allowSelf: true,
    });
});

test("p accepts provider-default reasoning without pinning a level", () => {
    const pane = startTuiModelAssignmentPicker(
        "subagents",
        "subagents",
        "delegated work",
        [{
            provider: "openrouter",
            model: "x-ai/grok-4.20",
            label: "Grok 4.20",
            available: true,
            verified: true,
            levels: [
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
            ],
            defaultLevel: "medium",
        }],
    );
    const modelIndex = pane.options.findIndex((option) =>
        option.value === "openrouter/x-ai/grok-4.20");

    expect(handleTuiSettingsPickerKey(
        { ...pane, selectedIndex: modelIndex },
        { name: "p" },
    ).selection).toEqual({
        kind: "model_assignment",
        assignment: "subagents",
        provider: "openrouter",
        model: "x-ai/grok-4.20",
        acceptDefaultReasoning: true,
    });
});

test("the subagent assignment says Not set only while its model list is empty", () => {
    const pane = startTuiModelAssignmentPicker(
        "subagents",
        "subagents",
        "delegated work",
        pooledModels,
        [],
        true,
        { provider: "openrouter", model: "z-ai/glm-5.2" },
    );

    expect(pane.options[0]).toMatchObject({
        label: "Not set",
        description: "no assigned models · parent fallback only",
        group: "Assigned · fallback order",
    });
});

test("the Defaults row reports the subagent assignment instead of generic set", () => {
    const assigned = {
        provider: "openrouter",
        model: "openai/gpt-5.6-luna",
        name: "luna",
    } as const;
    const row = (declared: readonly (typeof assigned)[]) => ({
        assignment: "subagents" as const,
        label: "subagents",
        intent: "delegated work, in fallback order",
        bound: declared.length > 0,
        declared,
        models: declared,
        source: "assignment" as const,
        allowSelf: false,
    });

    expect(tuiModelAssignmentOptions([row([assigned])])[2]?.description)
        .toBe("1 · openai/gpt-5.6-luna");
    expect(tuiModelAssignmentOptions([row([])])[2]?.description)
        .toBe("not set");
    expect(tuiModelAssignmentOptions([{
        ...row([]),
        bound: true,
        allowSelf: true,
    }])[2]?.description).toBe("parent fallback");
});

test("the verify-shortlist action asks how much of the collection it covers", () => {
    const actions = switchedModelTab(pickerWithActions(), "actions");
    const selectedIndex = actions.options.findIndex((option) =>
        option.label === "Verify shortlisted models"
    );
    const transition = handleTuiSettingsPickerKey(
        { ...actions, selectedIndex },
        { name: "enter" },
    );
    expect(transition.handled).toBe(true);
    expect(transition.poolVerifySweep).toBe(true);
});

test("the sweep scope pane offers the cheaper answer first", () => {
    const pane = startTuiPoolVerifyScopePicker(2, 9);
    expect(pane.options.map((option) => option.label)).toEqual([
        "Only the ones never probed (2)",
        "Everything on your shortlist (9)",
    ]);
    // Nothing left unprobed makes the first row a no-op, so the cursor starts
    // on the one that would actually do something.
    expect(pane.selectedIndex).toBe(0);
    expect(startTuiPoolVerifyScopePicker(0, 9).selectedIndex).toBe(1);
    expect(
        handleTuiSettingsPickerKey(pane, { name: "enter" }).selection,
    ).toEqual({ kind: "pool_verify_scope", onlyUnverified: true });
});

function pickerWithActions() {
    return {
        ...modelPickerWithPool(),
        actionOptions: tuiModelActionOptions(["openrouter"], { hasPool: true }),
    } as TuiSettingsPickerState;
}

test("the Actions tab lists what the pane can do in words", () => {
    const actions = switchedModelTab(pickerWithActions(), "actions");

    expect(actions.options.map((option) => option.label)).toEqual([
        "Refresh model catalog from providers",
        "Verify shortlisted models",
        "Show or hide the rarely used models",
        "Connect, edit or forget a provider",
    ]);
    // The chord sits on the row, so the tab teaches the key rather than
    // replacing it.
    expect(actions.options[0]?.description).toBe(
        tuiKeyHint("refresh_catalog").split(" ")[0],
    );
});

test("an action is found by word from the model list, above the models", () => {
    const state = updateTuiSettingsPickerSearch(
        pickerWithActions(),
        "refresh",
    ).state!;

    // Searching the shortlist narrows models. Actions are not models, so they
    // never appear in the column and never bring a heading with them.
    const labels = state.options.map((option) => option.label);
    expect(labels).not.toContain("Actions");
    expect(labels).not.toContain("Refresh model catalog from providers");
});

test("the refresh row asks which providers before asking any", () => {
    const actions = switchedModelTab(pickerWithActions(), "actions");
    const transition = handleTuiSettingsPickerKey(actions, { name: "return" });

    // Not a refresh yet: the row opens the question of scope, and the answer
    // to that is what spends the calls.
    expect(transition.refreshCatalogScope).toBe(true);
    expect(transition.refreshCatalog).toBeUndefined();
    expect(transition.selection).toBeUndefined();
});

test("the refresh scope pane leads with every provider and its size", () => {
    const scope = startTuiCatalogRefreshScopePicker([
        { name: "cerebras", models: 12 },
        { name: "openrouter", models: 348 },
    ]);

    expect(scope.options.map((option) => option.label)).toEqual([
        "Every provider (2)",
        "cerebras",
        "openrouter",
    ]);
    expect(scope.options[0]?.description).toBe("360 in their catalogs");
    expect(scope.selectedIndex).toBe(0);
});

test("one provider gets no every-provider row", () => {
    const scope = startTuiCatalogRefreshScopePicker([
        { name: "openrouter", models: 348 },
    ]);

    expect(scope.options.map((option) => option.label)).toEqual(["openrouter"]);
});

test("a scope answer names the providers to ask, and all names none", () => {
    const scope = startTuiCatalogRefreshScopePicker([
        { name: "cerebras", models: 12 },
        { name: "openrouter", models: 348 },
    ]);

    expect(handleTuiSettingsPickerKey(scope, { name: "return" }).selection)
        .toEqual({
            kind: "catalog_refresh_scope",
            providers: ["cerebras", "openrouter"],
        });
    expect(
        handleTuiSettingsPickerKey(
            { ...scope, selectedIndex: 2 },
            { name: "return" },
        ).selection,
    ).toEqual({ kind: "catalog_refresh_scope", providers: ["openrouter"] });
});

test("the providers row opens the provider pane", () => {
    let actions = switchedModelTab(pickerWithActions(), "actions");
    actions = {
        ...actions,
        selectedIndex: actions.options.findIndex((option) =>
            option.label.startsWith("Connect,")
        ),
    };

    expect(handleTuiSettingsPickerKey(actions, { name: "return" }).openProviders)
        .toBe(true);
});

test("an unsearched model list lists models only", () => {
    const all = switchedModelTab(pickerWithActions(), "all");

    expect(all.options.some((option) =>
        option.label.startsWith("Refresh openrouter")
    )).toBe(false);
});

test("All models puts its collection action under the list", async () => {
    const picker = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "auto",
        [...availableModels, {
            provider: "openrouter",
            model: "old/model",
            label: "Old model",
            description: "rarely used",
            hiddenByDefault: "old" as const,
        }],
        "default",
        "openrouter",
    );
    const all = {
        ...switchedModelTab(picker, "all"),
        actionOptions: tuiModelActionOptions(["openrouter"]),
    };
    // Showing every model is something the list does, so All models names it
    // on the same entry row the shortlist uses.
    const frame = await pickerFrame(all);
    expect(frame).toContain("show every model");
    expect(frame).toMatch(/More\s+.*\u203a/);

    const page = handleTuiSettingsPickerKey(
        handleTuiSettingsPickerKey(
            handleTuiSettingsPickerKey(
                { ...all, selectedIndex: 0 },
                { name: "up" },
            ).state!,
            { name: "up" },
        ).state!,
        { name: "return" },
    ).state!;
    expect(page.modelFocus).toBe("page");
    const pageFrame = await pickerFrame(page);
    expect(pageFrame).toMatch(/Show or hide the rarely used models\s+\^a/);
    const revealed = [0, 1, 2]
        .map((index) =>
            handleTuiSettingsPickerKey(
                { ...page, modelPageIndex: index },
                { name: "return" },
            ).state
        )
        .find((next) => next?.revealAll === true);
    expect(revealed?.tab).toBe("all");
});

test("the More page stands in for the list it covers", async () => {
    const picker = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );
    const all = {
        ...switchedModelTab(picker, "all"),
        actionOptions: tuiModelActionOptions(["openrouter"]),
    };
    const page = handleTuiSettingsPickerKey(
        handleTuiSettingsPickerKey(
            handleTuiSettingsPickerKey(
                { ...all, selectedIndex: 0 },
                { name: "up" },
            ).state!,
            { name: "up" },
        ).state!,
        { name: "return" },
    ).state!;
    const frame = await pickerFrame(page);
    // The cutoff slider, the facts header and the price card belong to the
    // list, and the list is not on screen while the page is open.
    expect(frame).not.toContain("Smarter");
    expect(frame).not.toContain("WA Score*");
    expect(frame).not.toContain("Blended price");
    // The rows read as the button's own menu, so they open right under it:
    // the bottom edge, the gap and the "More" heading are all that sit between.
    const lines = frame.split("\n");
    const entry = lines.findIndex((line) => line.includes("- More"));
    const first = lines.findIndex((line) =>
        line.includes("Refresh model catalog")
    );
    expect(entry).toBeGreaterThan(-1);
    expect(first - entry).toBe(4);
});

test("the More entry is a button that marks focus without color", async () => {
    const picker = startTuiSettingsPicker(
        "model",
        "z-ai/glm-5.2",
        "high",
        "auto",
        availableModels,
        "default",
        "openrouter",
    );
    const all = {
        ...switchedModelTab(picker, "all"),
        actionOptions: tuiModelActionOptions(["openrouter"]),
    };
    function buttonRows(frame: string): readonly string[] {
        const lines = frame.split("\n");
        const row = lines.findIndex((line) => line.includes("More \u00b7"));
        expect(row).toBeGreaterThan(-1);
        return lines.slice(row - 1, row + 2);
    }
    const resting = buttonRows(await pickerFrame({ ...all, selectedIndex: 0 }));
    expect(resting[0]).toContain("\u250c");
    expect(resting[1]).toContain("\u2502");
    expect(resting[2]).toContain("\u2514");
    // The door it opens, not an arrow the list rows also use.
    expect(resting[1]).toContain("\u203a");
    const focused = buttonRows(await pickerFrame(
        handleTuiSettingsPickerKey(
            handleTuiSettingsPickerKey(
                { ...all, selectedIndex: 0 },
                { name: "up" },
            ).state!,
            { name: "up" },
        ).state!,
    ));
    // A monochrome terminal reads the doubled edge; the accent is decoration.
    expect(focused[0]).toContain("\u2554");
    expect(focused[1]).toContain("\u2551");
    expect(focused[2]).toContain("\u255a");
});

test("the show-or-hide row lands on the list it changed", () => {
    let actions = switchedModelTab(pickerWithActions(), "actions");
    actions = {
        ...actions,
        selectedIndex: actions.options.findIndex((option) =>
            option.label.startsWith("Show or hide")
        ),
    };

    const revealed = handleTuiSettingsPickerKey(actions, { name: "return" })
        .state as TuiSettingsPickerState;
    expect(revealed.revealAll).toBe(true);
    expect(revealed.tab).toBe("all");
});

test("the developer pane shows only its toggle until it is on", () => {
    const off = startTuiDeveloperMenu({ enabled: false });

    expect(off.options.map((option) => option.value))
        .toEqual(["developer_enabled_on"]);
    expect(handleTuiSettingsPickerKey(off, { name: "enter" }).selection).toEqual({
        kind: "developer",
        patch: { enabled: true },
    });

    const on = startTuiDeveloperMenu({ enabled: true, contextLimit: 8_192 });

    expect(on.options.map((option) => option.value)).toEqual([
        "developer_enabled_off",
        "developer_context_limit",
        "developer_compaction_trigger",
        "developer_target_fraction",
        "developer_summary_words",
    ]);
    // The row carries the value in force, so the pane answers "what is it set
    // to" without a second step.
    expect(on.options[1]?.description).toContain("8k");
});

test("the settings menu says so while the developer block is on", () => {
    const off = startTuiSettingsMenu("settings");
    const on = startTuiSettingsMenu("settings", { enabled: true });
    const rowOf = (pane: typeof off) =>
        pane.options.find((option) => option.value === "developer");

    expect(rowOf(off)?.description).toBe("overrides for testing Vera itself");
    expect(rowOf(on)?.description).toBe("on: overrides are in force");
    // Only that row changes.
    expect(on.options.map((option) => option.value))
        .toEqual(off.options.map((option) => option.value));
});

test("turning the developer block on leaves its own rows on screen", () => {
    const off = startTuiDeveloperMenu({ enabled: false, contextLimit: 8_192 });
    const next = tuiPickerAfterSelection(
        { kind: "developer", patch: { enabled: true } },
        { ...off, parent: startTuiSettingsMenu("settings") },
    );

    expect(next?.kind).toBe("developer_settings");
    expect(next?.options.map((option) => option.value)).toEqual([
        "developer_enabled_off",
        "developer_context_limit",
        "developer_compaction_trigger",
        "developer_target_fraction",
        "developer_summary_words",
    ]);
    // The value the block already held survives the toggle.
    expect(next?.options[1]?.description).toContain("8k");
});

test("a developer value pane writes one field, and Off clears it", () => {
    const pane = startTuiDeveloperValuePicker("developer_context_limit", {
        enabled: true,
        contextLimit: 8_192,
    });
    if (pane === undefined) throw new Error("no developer value pane");

    expect(pane.options[pane.selectedIndex]?.value).toBe("8192");
    expect(handleTuiSettingsPickerKey(pane, { name: "enter" }).selection).toEqual({
        kind: "developer",
        patch: { contextLimit: 8_192 },
    });
    expect(handleTuiSettingsPickerKey({ ...pane, selectedIndex: 0 }, { name: "enter" })
        .selection).toEqual({
        kind: "developer",
        patch: { contextLimit: null },
    });
});
