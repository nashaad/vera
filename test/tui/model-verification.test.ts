import { expect, test } from "bun:test";
import { handleVerificationKey, verificationPicker, verificationResults } from "../../clients/tui/model-verification.ts";
import { modelBrowse } from "../../clients/tui/model-browse.ts";
import { startTuiSettingsPicker, syncTuiModelPicker } from "../../clients/tui/settings-picker.ts";
const models = [
    { provider: "p", model: "one", verified: false },
    { provider: "q", model: "two", verified: true },
];
test("one verification screen combines provider scope and coverage with disabled zero-target scopes", () => {
    const state = verificationPicker(models);
    expect(state.options.map((row) => [row.value, row.unavailable])).toEqual([["", false], ["p", false], ["q", true]]);
    expect(handleVerificationKey({ ...state, selectedIndex: 2 }, { name: "enter" }).selection).toBeUndefined();
    const all = handleVerificationKey({ ...state, selectedIndex: 2 }, { name: "tab" }).state!;
    expect(all.subtitle).toContain("All favorites");
    expect(handleVerificationKey(all, { name: "enter" }).selection)
        .toEqual({ kind: "pool_verify_scope", onlyUnverified: false, provider: "q" });
});
test("results retain waiting, passed and failed rows with failure reasons", () => {
    const state = verificationResults({ running: true, targets: models, results: [
        { provider: "p", model: "one", status: "failed", reason: "No response" },
    ] });
    expect(state.options.map((row) => row.description)).toEqual(["failed: No response", "waiting"]);
    expect(state.subtitle).toContain("Leaving this screen does not stop");
    expect(state.subtitle).toContain("failure changes no existing assignment");
    expect(handleVerificationKey(state, { name: "escape" })).toEqual({ state: undefined, handled: true });
});

test("verification progress and completion preserve the caller and results cursor", () => {
    const parent = { ...verificationPicker(models), selectedIndex: 1, onlyUnverified: false };
    const started = handleVerificationKey(parent, { name: "enter" });
    expect(started.state).toBe(parent);
    const run = { running: true, targets: models, results: [] };
    const results = { ...verificationResults(run, parent), selectedIndex: 1 };
    const progress = verificationResults({ ...run, results: [{ ...models[0]!, status: "passed" }] }, results);
    expect(progress.selectedIndex).toBe(1);
    expect(handleVerificationKey(progress, { name: "escape" }).state).toBe(parent);
    const complete = verificationResults({ ...run, running: false }, progress);
    expect(complete.selectedIndex).toBe(1);
    expect(handleVerificationKey(complete, { name: "escape" }).state).toBe(parent);
});

test("a snapshot during a run reaches the pane the screen returns to", () => {
    const parent = modelBrowse(startTuiSettingsPicker(
        "model",
        "one",
        undefined,
        undefined,
        [{ provider: "p", model: "one", label: "One", description: "" }],
        undefined,
        "p",
    ), "favorites");
    expect(parent.allOptions.filter((row) => row.pooledRank !== undefined)).toHaveLength(0);
    const results = verificationResults({ running: true, targets: models, results: [] }, parent);
    const synced = syncTuiModelPicker(results, {
        provider: "p",
        model: "one",
        availableModels: [{ provider: "p", model: "one", label: "One", description: "" }],
        pooled: [{ provider: "p", model: "one", label: "One", available: true, verified: true, levels: [] }],
    });
    const returned = handleVerificationKey(synced, { name: "escape" }).state!;
    expect(returned.kind).toBe("model");
    expect(returned.allOptions.filter((row) => row.pooledRank !== undefined)).toHaveLength(1);
});
