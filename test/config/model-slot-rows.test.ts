import { expect, test } from "bun:test";

import {
    describeModelSlots,
    type VeraModelSlotsConfig,
} from "../../src/config/model-slots.ts";
import type { VeraModelCatalogConfig } from "../../src/config/model-catalog.ts";
import { tuiModelSlotOptions } from "../../clients/tui/settings-picker.ts";

const CATALOG: VeraModelCatalogConfig = {
    models: [
        { name: "big", provider: "openrouter", model: "big-1", reasoning_effort: "high" },
        { name: "small", provider: "cerebras", model: "small-1" },
    ],
    model_routes: { best: ["big"], cheap: ["small"] },
    reviewer_profiles: {},
};

function rows(slots: VeraModelSlotsConfig, reachable?: (name: string) => boolean) {
    return describeModelSlots(
        CATALOG,
        slots,
        reachable === undefined
            ? undefined
            : (entry) => reachable(entry.name),
    );
}

test("an unset job slot reports the intent it inherits", () => {
    const reviewer = rows({ extra: { model_route: "best" } })
        .find((row) => row.slot === "reviewer");
    expect(reviewer?.route).toBeUndefined();
    expect(reviewer?.source).toBe("intent");
    expect(reviewer?.inherits).toBe("extra");
    expect(reviewer?.models.map((model) => model.name)).toEqual(["big"]);
});

test("an unreachable route stays on the row next to its substitute", () => {
    const reviewer = rows(
        { extra: { model_route: "best" }, reviewer: { model_route: "cheap" } },
        (name) => name !== "small",
    ).find((row) => row.slot === "reviewer");
    expect(reviewer?.route).toBe("cheap");
    expect(reviewer?.declared.map((model) => model.name)).toEqual(["small"]);
    expect(reviewer?.source).toBe("intent");
    expect(reviewer?.models.map((model) => model.name)).toEqual(["big"]);
});

test("compaction with nothing bound falls to the session's model", () => {
    const compaction = rows({}).find((row) => row.slot === "compaction");
    expect(compaction?.source).toBe("session");
    expect(compaction?.models).toEqual([]);
});

test("the rows show the route, the substitute, and the unset ones", () => {
    const options = tuiModelSlotOptions(
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
    const described = new Map(
        options.map((option) => [option.label, option.description]),
    );
    expect(described.get("This session")).toContain("session-model");
    expect(described.get("extra")).toBe("best · big-1 (high)");
    expect(described.get("critic")).toBe("cheap unreachable · uses extra");
    expect(described.get("snappy")).toBe("cheap unreachable · nothing runs it");
    expect(described.get("eco")).toBe("not set");
    expect(described.get("compaction")).toBe("not set · uses this session's model");
});

test("a slot bound to inline models needs no route", () => {
    const extra = rows({
        extra: {
            models: [
                { name: "picked", provider: "openrouter", model: "big-1" },
            ],
        },
    }).find((row) => row.slot === "extra");
    expect(extra?.bound).toBe(true);
    expect(extra?.route).toBeUndefined();
    expect(extra?.source).toBe("slot");
    expect(extra?.models.map((model) => model.model)).toEqual(["big-1"]);
});

test("a slot naming both a route and inline models is refused", async () => {
    const { parseModelSlotsConfig } = await import(
        "../../src/config/model-slots.ts"
    );
    expect(parseModelSlotsConfig(
        {
            extra: {
                model_route: "best",
                models: [{ provider: "openrouter", model: "big-1" }],
            },
        },
        { best: ["big"] },
    )).toBeUndefined();
});

test("a slots row resolves to its slot, not to a model", async () => {
    const { handleTuiSettingsPickerKey } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const options = tuiModelSlotOptions(rows({}), "session-model");
    const pane = {
        kind: "model" as const,
        allOptions: [],
        options,
        selectedIndex: options.findIndex((option) => option.label === "extra"),
        query: "",
        tab: "slots" as const,
        slotOptions: options,
    };
    const selection = handleTuiSettingsPickerKey(pane, { name: "return" })
        .selection;
    expect(selection).toEqual({ kind: "model_slot_open", slot: "extra" });
});

test("the session row moves to the list that changes it", async () => {
    const { handleTuiSettingsPickerKey } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const options = tuiModelSlotOptions(rows({}), "session-model");
    const pane = {
        kind: "model" as const,
        allOptions: [],
        options,
        selectedIndex: 0,
        query: "",
        tab: "slots" as const,
        slotOptions: options,
    };
    const transition = handleTuiSettingsPickerKey(pane, { name: "return" });
    expect(transition.selection).toBeUndefined();
    expect(transition.state?.tab).toBe("all");
});

test("a slot is bound only from the pool", async () => {
    const { startTuiModelSlotPicker } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const pane = startTuiModelSlotPicker("extra", "best", undefined, [
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

test("slot rows survive a snapshot from the host", async () => {
    const { syncTuiModelPicker, switchedModelTab } = await import(
        "../../clients/tui/settings-picker.ts"
    );
    const options = tuiModelSlotOptions(rows({}), "session-model");
    const opened = {
        kind: "model" as const,
        allOptions: [],
        options: [],
        selectedIndex: 0,
        query: "",
        tab: "all" as const,
        slotOptions: options,
    };
    const synced = syncTuiModelPicker(opened, { model: "session-model" });
    expect(switchedModelTab(synced, "slots").options.length).toBe(
        options.length,
    );
});
