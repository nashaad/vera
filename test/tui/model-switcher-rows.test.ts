import { expect, test } from "bun:test";
import { modelSwitcherRows } from "../../clients/tui/main/model-switcher-ops.ts";
import { startTuiModelSwitcher } from "../../clients/tui/model-switcher.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";

const availableModels = [
    { provider: "openrouter", model: "crow/plank-walker", label: "Crow: Plank Walker", description: "" },
    { provider: "openrouter", model: "crow/old-salt:free", label: "Crow: Old Salt (free)", description: "", hiddenByDefault: "old" },
    { provider: "openrouter", model: "crow/barnacle", label: "Crow: Barnacle", description: "", hiddenByDefault: "old" },
];

function runtime(pooled: readonly { provider: string; model: string }[]): TuiRuntime {
    return {
        sidebar: { isFocused: () => false },
        hostedSidebar: {},
        state: { modelSettings: { availableModels, pooled }, modelSettingsHistory: [] },
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
