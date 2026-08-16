import { expect, test } from "bun:test";

import {
    describeModelAssignments,
    type VeraModelAssignmentsConfig,
} from "../../src/config/model-assignments.ts";
import type { VeraModelCatalogConfig } from "../../src/config/model-catalog.ts";
import { tuiModelAssignmentOptions } from "../../clients/tui/settings-picker.ts";

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
    expect(status.get("this session")).toBe("");
    expect(status.get("extra")).toBe("set");
    expect(status.get("snappy")).toBe("not in pool");
    expect(status.get("critic")).toBe("not in pool");
    expect(status.get("eco")).toBe("not set");
    // eco is unset in this fixture, so compaction falls past it to the session.
    expect(status.get("compaction")).toBe("uses session");
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
        tab: "assigned" as const,
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
        tab: "assigned" as const,
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
    expect(pane.options.map((option) => option.label)).toEqual([
        "Not set",
        "big",
    ]);
    // The intent names the pane, and the unset row says what unset does.
    expect(pane.title).toBe("Assign a model to extra");
    expect(pane.subtitle).toBe("more thinking");
    expect(pane.options[0]?.description).toBe("nothing runs it");
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
    expect(switchedModelTab(synced, "assigned").options.length).toBe(
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
        ["Runs", "nothing"],
        ["Set to", 'route "cheap"'],
        ["If unset", "the work is skipped"],
        ["In pool", "no"],
    ]);
    expect(cell.get("snappy")?.note).toContain(
        "The model it is set to is not in your pool, so nothing runs it.",
    );
    // A job row names the substitute that actually ran.
    expect(cell.get("reviewer")?.detailFacts).toEqual([
        ["Runs", "big-1 (high) (via extra)"],
        ["Set to", "nothing"],
        ["If unset", "whatever extra uses"],
    ]);
    expect(cell.get("extra")?.detailFacts?.[3]).toEqual(["In pool", "yes"]);
});
