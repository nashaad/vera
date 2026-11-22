import { expect, test } from "bun:test";
import { modelSwitcherRows } from "../../clients/tui/main/model-switcher-ops.ts";
import { startTuiModelSwitcher } from "../../clients/tui/model-switcher.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";

const availableModels = [
    { provider: "openrouter", model: "crow/plank-walker", label: "Crow: Plank Walker", description: "" },
    { provider: "openrouter", model: "crow/old-salt:free", label: "Crow: Old Salt (free)", description: "", hiddenByDefault: "old" },
    { provider: "openrouter", model: "crow/barnacle", label: "Crow: Barnacle", description: "", hiddenByDefault: "old" },
];

function runtime(
    pooled: readonly { provider: string; model: string }[],
    current?: { provider: string; model: string },
): TuiRuntime {
    return {
        sidebar: { isFocused: () => false },
        hostedSidebar: {},
        state: {
            modelSettings: { availableModels, pooled, ...(current ?? {}) },
            modelSettingsHistory: [],
        },
    } as unknown as TuiRuntime;
}

test("a favorite the catalog hides as old still reaches the switcher", () => {
    const rows = modelSwitcherRows(runtime([{ provider: "openrouter", model: "crow/old-salt:free" }]));
    expect(rows.map((row) => row.model)).toEqual(["crow/plank-walker", "crow/old-salt:free"]);
    expect(rows.find((row) => row.model === "crow/old-salt:free")?.favorite).toBe(true);

    const state = startTuiModelSwitcher(rows);
    expect(state.rows.map((row) => row.model)).toEqual(["crow/old-salt:free"]);
});

test("a hidden model that is not a favorite stays out", () => {
    const rows = modelSwitcherRows(runtime([]));
    expect(rows.map((row) => row.model)).toEqual(["crow/plank-walker"]);
});

test("a running favorite its provider dropped keeps its row, marked unavailable", () => {
    const rows = modelSwitcherRows(
        runtime(
            [{ provider: "openrouter", model: "crow/gone" }],
            { provider: "openrouter", model: "crow/gone" },
        ),
    );
    const row = rows.find((entry) => entry.model === "crow/gone");
    expect(row?.favorite).toBe(true);
    expect(row?.unavailable).toBe(true);
    const state = startTuiModelSwitcher(rows, { current: "openrouter/crow/gone" });
    expect(state.rows[0]?.model).toBe("crow/gone");
});

test("a dropped favorite that is not running stays out", () => {
    const rows = modelSwitcherRows(runtime([{ provider: "openrouter", model: "crow/gone" }]));
    expect(rows.map((row) => row.model)).toEqual(["crow/plank-walker"]);
});

test("a dropped favorite returns when its provider offers it again", () => {
    const rows = modelSwitcherRows(
        runtime(
            [{ provider: "openrouter", model: "crow/old-salt:free" }],
            { provider: "openrouter", model: "crow/plank-walker" },
        ),
    );
    const row = rows.find((entry) => entry.model === "crow/old-salt:free");
    expect(row?.favorite).toBe(true);
    expect(row?.unavailable).toBeUndefined();
});
