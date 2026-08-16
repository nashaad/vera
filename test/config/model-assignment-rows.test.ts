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

test("the rows line up in columns and say why each model is there", () => {
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
    // Every name column is the same width, so the model column starts at the
    // same character on every row.
    const starts = new Set(
        options.map((option) => option.label.search(/\S+(\s\S+)*$/)),
    );
    expect(starts.size).toBe(1);
    const cell = new Map(options.map((option) => {
        const [name, model] = option.label.split(/\s{2,}/);
        return [name!.trim(), { model: model ?? "", state: option.description }];
    }));
    expect(cell.get("this session")).toEqual({
        model: "session-model",
        state: "enter to change",
    });
    expect(cell.get("extra")).toEqual({ model: "big-1 (high)", state: "" });
    // The substitute runs, and the row still names the route that did not, so
    // the user can see what to fix.
    expect(cell.get("critic")).toEqual({
        model: "big-1 (high)",
        state: "route cheap unreachable, uses extra",
    });
    expect(cell.get("snappy")).toEqual({
        model: "\u00b7",
        state: "route cheap unreachable",
    });
    expect(cell.get("eco")).toEqual({ model: "\u00b7", state: "not set" });
    expect(cell.get("compaction")).toEqual({
        model: "\u00b7",
        state: "uses session model",
    });
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
    const pane = startTuiModelAssignmentPicker("extra", "best", undefined, [
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
