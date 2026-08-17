import type { PooledModel } from "../../src/model/catalog-view.ts";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    handleTuiSettingsPickerKey,
    handleTuiSettingsPickerScroll,
    startTuiSettingsMenu,
    startTuiSettingsPicker,
    switchedModelTab,
    startTuiProviderPicker,
    startTuiReasoningPicker,
    startTuiSessionPicker,
    startTuiExtensionPicker,
    createTuiSettingsPickerView,
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

test("inset pickers start one quarter down the terminal", async () => {
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
        expect(view.box.top).toBe(10);

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

test("session search accepts spaces between words", () => {
    let state = startTuiSessionPicker([{
        id: "11111111-first-session",
        workspace: "/work/alpha",
        session_path: "/sessions/first.jsonl",
        kind: "interactive",
        status: "idle",
        live: false,
        title: "Turn planning",
    }]);
    for (const name of ["t", "u", "r", "n", "space", "p"]) {
        state = handleTuiSettingsPickerKey(state, { name }).state ?? state;
    }
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
        });
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
        label: "Z-AI: GLM-5.2",
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
    // choice carries the current-dot. The dot hangs in the card's padding, so
    // the label starts on the same column as every other line in the card.
    expect(frame).toMatch(/openrouter\s+\n/);
    expect(frame).toMatch(/●\s+GLM-5\.2/);
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
    expect(await pickerFrame(filteredPermissions)).toContain("full");
});

test("digits quick-select on the short panes and stay search input elsewhere", async () => {
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
    const filtered = handleTuiSettingsPickerKey(reasoning, { name: "m" });
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
    const typed = handleTuiSettingsPickerKey(model, { name: "5" });
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
        "reviewer",
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
        "Quickslots",
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
        "muted-blue",
        "orng",
        "palenight",
        "synthwave",
        "nightowl",
        "github",
        "midnight-blue",
        "midnight-blue-ii",
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

test("the model pane opens on Pool, in the order the user's own use produced", async () => {
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
    expect(frame).toContain("All models");
    expect(frame).toContain("Pool");
    expect(frame).toMatch(
        /Pool \(2\).*All models \(2\).*\n.*Your curated shortlist\..*\n.*GPT-5\.6-Sol/,
    );
});

test("the pane opens on Pool even when the running model is not in it", () => {
    // The pool is the list the user built for this moment, so it opens whether
    // or not the model in effect happens to be on it.
    const state = modelPickerWithPool(pooledModels, "sonnet-4.5", "anthropic");
    expect(state.tab).toBe("pool");
});

test("with an empty pool the pane opens on All models, full width", async () => {
    // An empty tab answers no question, so the pane falls back to the list that
    // can always answer "which model do I switch to".
    const state = modelPickerWithPool([]);
    expect(state.tab).toBe("all");
    // Hundreds of rows, read by scanning names: the whole card goes to the
    // names rather than half of it to facts about one of them.
    const frame = await pickerFrame(state);
    expect(frame).toContain("All models");
    expect(frame).not.toContain("\u2502");
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
        expect(state.tab).toBe("all");
        expect(tuiPickerViewportRows(setup.renderer, state)).toBe(24);
        expect(view.box.height).toBeLessThan(40);
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

    // The cycle is Pool, All models, Slots, Help, and round again.
    const slots = handleTuiSettingsPickerKey(allTab!, { name: "tab" }).state!;
    expect(slots.tab).toBe("assigned");
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
    const frame = await pickerFrame(allTabWithRecommendations());

    // Under the Top picks heading the words would only repeat it.
    expect(frame).not.toContain("top pick");
    const opened = await pickerFrame(
        handleTuiSettingsPickerKey(
            { ...allTabWithRecommendations(), selectedIndex: 2 },
            { name: "return" },
        ).state!,
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
    const frame = await pickerFrame(help);

    expect(frame).toContain("the model this conversation is running");
    expect(frame).toContain("answered a live probe");
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
    expect(lines[title + 2]).toStartWith("Pool (2)");
    expect(frame).toContain("⇥ tabs · esc close");
    // The chip carries no count, because Help is not a collection of models.
    expect(frame).toMatch(/Help\s/);
    expect(frame).not.toMatch(/Help \d/);
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

    // All -> Slots -> Help -> Pool, the long way round the strip.
    let pool = folded;
    for (let step = 0; step < 3; step += 1) {
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
    const searched = handleTuiSettingsPickerKey(folded, { name: "g" }).state!;
    expect(modelRows(searched).map((option) => option.label)).toEqual([
        "GLM-5.2",
    ]);
    expect(sectionRows(searched)).toEqual([["openrouter", false]]);

    // Clearing the query puts the fold back.
    const cleared = handleTuiSettingsPickerKey(searched, { name: "backspace" })
        .state!;
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
    expect(await pickerFrame({ ...state, selectedIndex: 1 }, 100))
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

test("an unprobed pool row keeps its row clean and offers the verify key", async () => {
    const state = modelPickerWithPool([{
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        label: "GLM-5.2",
        available: true,
        verified: false,
        levels: [],
    }]);
    const frame = await pickerFrame(state);

    expect(state.tab).toBe("pool");
    // The row runs like any other and says nothing about the probe it has not
    // had: the column beside the list carries that, and the footer offers the
    // probe as a deliberate act. The provider is in that column too.
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
    expect(frame).toMatch(/│  Model ID\s*\n.*│  openai\/gpt-5\.3-codex-spark/);
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

    expect(
        handleTuiSettingsPickerKey(state, { name: "r", ctrl: true, shift: true })
            .poolVerify,
    ).toEqual({
        provider: "openrouter",
        model: "z-ai/glm-5.2",
    });
    // Without the shift the chord means nothing here, so nothing is probed.
    expect(handleTuiSettingsPickerKey(state, { name: "r", ctrl: true })
        .poolVerify).toBeUndefined();
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

test("a search stays inside the tab it was typed on", () => {
    const onPool = modelPickerWithPool();
    const searched = handleTuiSettingsPickerKey(onPool, { name: "k" });

    // kimi is runnable but not pooled, so it has no row on this tab, and a
    // search must not conjure one: the heading says Pool, so the rows under it
    // are the pool.
    expect(searched.state?.options.map((option) => option.model))
        .not.toContain("moonshotai/kimi-k3");

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
    expect(await pickerFrame(onPoolRow)).toContain("^s remove");

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
    expect(await pickerFrame(onUnpooledRow)).toContain("^s pool");
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
    expect(frame).toMatch(/Pool \(2\)\s+All models \(\d+\)\s+Assigned\s+Help\s+Providers \^e/);
    expect(frame).toContain("⇥ tabs");
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
    expect(pickerFooter(synced)).toContain("remove");
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

test("the footer offers the name key on a pooled row and not on an unpooled one", () => {
    const pooled = modelPickerWithPool(
        pooledModels,
        "gpt-5.6-sol",
        "openai-codex",
    );
    expect(pickerFooter(pooled)).toContain("name");

    const unpooled = modelPickerWithPool([], "moonshotai/kimi-k3");
    expect(pickerFooter(unpooled)).not.toContain("name");
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
