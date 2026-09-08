import { expect, test } from "bun:test";

import {
    describeModelAssignments,
    type VeraModelAssignmentsConfig,
} from "../../src/config/model-assignments.ts";
import type { VeraModelCatalogConfig } from "../../src/config/model-catalog.ts";
import { configuredModelAssignments } from "../../src/config.ts";
import {
    MODEL_ASSIGNMENT_BROWSE_VALUE,
    tuiModelAssignmentOptions,
} from "../../clients/tui/settings-picker.ts";

const CATALOG: VeraModelCatalogConfig = {
    models: [
        { name: "big", provider: "openrouter", model: "big-1", reasoning_effort: "high" },
        { name: "small", provider: "cerebras", model: "small-1" },
    ],
    model_routes: { best: ["big"], cheap: ["small"] },
    reviewer_profiles: {},
};

function rows(assignments: VeraModelAssignmentsConfig, reachable?: (name: string) => boolean) {
    return describeModelAssignments(
        CATALOG,
        assignments,
        reachable === undefined
            ? undefined
            : (entry) => reachable(entry.name),
    );
}

test("an unset job assignment reports the intent it inherits", () => {
    const reviewer = rows({ extra: { model_route: "best" } })
        .find((row) => row.assignment === "reviewer");
    expect(reviewer?.route).toBeUndefined();
    expect(reviewer?.source).toBe("intent");
    expect(reviewer?.inherits).toBe("extra");
    expect(reviewer?.models.map((model) => model.name)).toEqual(["big"]);
});

test("an unreachable route stays on the row next to its substitute", () => {
    const reviewer = rows(
        { extra: { model_route: "best" }, reviewer: { model_route: "cheap" } },
        (name) => name !== "small",
    ).find((row) => row.assignment === "reviewer");
    expect(reviewer?.route).toBe("cheap");
    expect(reviewer?.declared.map((model) => model.name)).toEqual(["small"]);
    expect(reviewer?.source).toBe("intent");
    expect(reviewer?.models.map((model) => model.name)).toEqual(["big"]);
});

test("compaction with nothing bound falls to the session's model", () => {
    const compaction = rows({}).find((row) => row.assignment === "compaction");
    expect(compaction?.source).toBe("session");
    expect(compaction?.models).toEqual([]);
});

test("a row is its name and one status word", () => {
    const options = tuiModelAssignmentOptions(
        rows(
            {
                snappy: { model_route: "cheap" },
                extra: { model_route: "best" },
                reviewer: { model_route: "cheap", label: "critic" },
            },
            (name) => name !== "small",
        ),
        "session-model",
    );
    const status = new Map(
        options.map((option) => [option.label, option.description]),
    );
    // Nothing in the list is longer than a word or two, so no row can clip.
    expect(status.get("model")).toBe("");
    expect(status.get("extra")).toBe("set");
    expect(status.get("snappy")).toBe("not in your library");
    expect(status.get("critic")).toBe("not in your library");
    // Nothing is ever left unrun: an unset row names what runs it instead.
    expect(status.get("eco")).toBe("uses session");
    // eco is unset in this fixture, so compaction falls past it to the session.
    expect(status.get("compaction")).toBe("uses session");
});

test("defaults separate session controls, work styles, and dedicated jobs", async () => {
    const { handleTuiSettingsPickerKey } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const options = tuiModelAssignmentOptions(
        rows({}),
        "session-model",
        undefined,
        204_800,
    );
    expect(options.map((option) => [option.label, option.group])).toEqual([
        ["model", "This session"],
        ["context limit", "Global"],
        ["snappy", "Work styles"],
        ["eco", "Work styles"],
        ["extra", "Work styles"],
        ["classifier", "Dedicated jobs"],
        ["compaction", "Dedicated jobs"],
        ["subagents", "Dedicated jobs"],
    ]);

    const contextIndex = options.findIndex((option) =>
        option.label === "context limit"
    );
    const pane = {
        kind: "model" as const,
        allOptions: [],
        options,
        selectedIndex: contextIndex,
        query: "",
        tab: "defaults" as const,
        assignmentOptions: options,
    };
    expect(handleTuiSettingsPickerKey(pane, { name: "return" }).selection)
        .toEqual({ kind: "menu", target: "context_limit" });
});

test("a assignment bound to inline models needs no route", () => {
    const extra = rows({
        extra: {
            models: [
                { name: "picked", provider: "openrouter", model: "big-1" },
            ],
        },
    }).find((row) => row.assignment === "extra");
    expect(extra?.bound).toBe(true);
    expect(extra?.route).toBeUndefined();
    expect(extra?.source).toBe("assignment");
    expect(extra?.models.map((model) => model.model)).toEqual(["big-1"]);
});

test("fresh config projects an inline assignment without catalog fields", () => {
    const subagents = configuredModelAssignments({
        schema_version: 1,
        provider: "openrouter",
        model: "parent",
        approval_mode: "auto",
        model_assignments: {
            subagents: {
                models: [{
                    name: "worker",
                    provider: "ollama",
                    model: "worker",
                }],
            },
        },
    }).find((row) => row.assignment === "subagents");

    expect(subagents?.declared).toEqual([{
        name: "worker",
        provider: "ollama",
        model: "worker",
    }]);
    expect(subagents?.bound).toBe(true);
});

test("a assignment naming both a route and inline models is refused", async () => {
    const { parseModelAssignmentsConfig } = await import(
        "../../src/config/model-assignments.ts"
    );
    expect(parseModelAssignmentsConfig(
        {
            extra: {
                model_route: "best",
                models: [{ provider: "openrouter", model: "big-1" }],
            },
        },
        { best: ["big"] },
    )).toBeUndefined();
});

test("a assignments row resolves to its assignment, not to a model", async () => {
    const { handleTuiSettingsPickerKey } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const options = tuiModelAssignmentOptions(rows({}), "session-model");
    const pane = {
        kind: "model" as const,
        allOptions: [],
        options,
        selectedIndex: options.findIndex((option) =>
            option.label.startsWith("extra")
        ),
        query: "",
        tab: "defaults" as const,
        assignmentOptions: options,
    };
    const selection = handleTuiSettingsPickerKey(pane, { name: "return" })
        .selection;
    expect(selection).toEqual({ kind: "model_assignment_open", assignment: "extra" });
});

test("the session row moves to the list that changes it", async () => {
    const { handleTuiSettingsPickerKey } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const options = tuiModelAssignmentOptions(rows({}), "session-model");
    const pane = {
        kind: "model" as const,
        allOptions: [],
        options,
        selectedIndex: 0,
        query: "",
        tab: "defaults" as const,
        assignmentOptions: options,
    };
    const transition = handleTuiSettingsPickerKey(pane, { name: "return" });
    expect(transition.selection).toBeUndefined();
    expect(transition.state?.tab).toBe("all");
});

test("a assignment is bound only from the pool", async () => {
    const { startTuiModelAssignmentPicker } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const pane = startTuiModelAssignmentPicker("extra", "extra", "more thinking", [
        {
            provider: "openrouter",
            model: "kimi-k3",
            label: "Kimi K3",
            poolName: "big",
            available: true,
            verified: true,
            levels: [],
        },
    ]);
    expect(pane.options.slice(0, 2).map((option) => option.label)).toEqual([
        "Not set",
        "big",
    ]);
    // The way out is the last row, so a model that is not kept yet is a step
    // away rather than absent with no reason given. Asserted by value, since
    // the label is built from the collection tab's own name.
    expect(pane.options.at(-1)?.value).toBe(MODEL_ASSIGNMENT_BROWSE_VALUE);
    // The intent names the pane, and the unset row says what unset does.
    expect(pane.title).toBe("Assign a model to extra");
    expect(pane.subtitle).toBe("more thinking");
    expect(pane.options[0]?.description).toBe("uses this session's model");
});

test("assignment rows survive a snapshot from the host", async () => {
    const { syncTuiModelPicker, switchedModelTab } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const options = tuiModelAssignmentOptions(rows({}), "session-model");
    const opened = {
        kind: "model" as const,
        allOptions: [],
        options: [],
        selectedIndex: 0,
        query: "",
        tab: "all" as const,
        assignmentOptions: options,
    };
    const synced = syncTuiModelPicker(opened, { model: "session-model" });
    expect(switchedModelTab(synced, "defaults").options.length).toBe(
        options.length,
    );
});

test("the highlighted row explains itself beside the list", () => {
    const options = tuiModelAssignmentOptions(
        rows(
            { snappy: { model_route: "cheap" }, extra: { model_route: "best" } },
            (name) => name !== "small",
        ),
        "session-model",
    );
    const cell = new Map(options.map((option) => [option.label, option]));
    expect(cell.get("snappy")?.detailFacts).toEqual([
        ["Runs", "this session's model"],
        ["Set to", 'route "cheap"'],
        ["If unset", "this session's model"],
        ["In library", "no"],
    ]);
    expect(cell.get("snappy")?.note).toContain(
        "not in your library, so this session's model runs it instead",
    );
    // A job row names the substitute that actually ran.
    expect(cell.get("classifier")?.detailFacts).toEqual([
        ["Runs", "big-1 (high) (via extra)"],
        ["Set to", "nothing"],
        ["If unset", "whatever extra uses"],
    ]);
    expect(cell.get("extra")?.detailFacts?.[3]).toEqual(["In library", "yes"]);
});

test("ordinary assignment rows always name what runs when unset", () => {
    const options = tuiModelAssignmentOptions(rows({}), "session-model");
    for (const option of options.filter((option) =>
        option.label !== "subagents"
        && option.detailFacts?.some(([label]) => label === "If unset")
    )) {
        const unset = option.detailFacts?.find(([label]) => label === "If unset");
        expect([option.label, unset?.[1]]).toEqual([
            option.label,
            expect.stringMatching(/session's model|whatever \w+ uses/),
        ]);
    }
    expect(options.find((option) => option.label === "subagents")?.detailFacts)
        .toContainEqual(["If unset", "spawn is refused"]);
});

test("the session row names its level the way every other row does", () => {
    const withLevel = tuiModelAssignmentOptions(rows({}), "session-model", "high");
    expect(withLevel[0]?.detailFacts).toEqual([["Runs", "session-model (high)"]]);
    const withoutLevel = tuiModelAssignmentOptions(rows({}), "session-model");
    expect(withoutLevel[0]?.detailFacts).toEqual([["Runs", "session-model"]]);
});

test("a level pane chained from an assignment binds the assignment", async () => {
    const { handleTuiSettingsPickerKey, startTuiReasoningPicker } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const modelPane = {
        kind: "model_assignment" as const,
        allOptions: [],
        options: [],
        selectedIndex: 0,
        query: "" as const,
        modelAssignment: "extra" as const,
    };
    const pane = startTuiReasoningPicker(
        [{ id: "high", label: "high" }],
        "high",
        undefined,
        {
            provider: "openrouter",
            model: "big-1",
            modelPaneState: modelPane,
            assignment: "extra",
        },
    );
    expect(handleTuiSettingsPickerKey(pane, { name: "return" }).selection)
        .toEqual({
            kind: "model_assignment",
            assignment: "extra",
            provider: "openrouter",
            model: "big-1",
            reasoningEffort: "high",
        });
    // Escape still steps back to the pane the chain started on.
    expect(handleTuiSettingsPickerKey(pane, { name: "escape" }).state?.kind)
        .toBe("model_assignment");
});
