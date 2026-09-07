import { expect, test } from "bun:test";
import { handleVerificationKey, verificationPicker, verificationResults, verificationNudge } from "../../clients/tui/model-verification.ts";
const models = [
    { provider: "p", model: "one", verified: false },
    { provider: "q", model: "two", verified: true },
];
test("one verification screen combines provider scope and coverage with disabled zero-target scopes", () => {
    const state = verificationPicker(models);
    expect(state.options.map((row) => [row.value, row.unavailable])).toEqual([["", false], ["p", false], ["q", true]]);
    expect(handleVerificationKey({ ...state, selectedIndex: 2 }, { name: "enter" }).selection).toBeUndefined();
    const all = handleVerificationKey({ ...state, selectedIndex: 2 }, { name: "tab" }).state!;
    expect(all.subtitle).toContain("unverified only [all]");
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

test("the verification nudge is dismissible for the session", () => {
    expect(verificationNudge(models, false)).toContain("1 kept models unverified");
    expect(verificationNudge(models, true)).toBeUndefined();
    expect(verificationNudge([{ verified: true }], false)).toBeUndefined();
});
