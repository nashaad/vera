import { tuiBindingId } from "./keymap.ts";
import type { ModelOperationResult, ModelReference } from "../../src/model/model-operations.ts";
import type { TuiSettingsPickerKey, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

export interface VerificationTarget extends ModelReference { readonly verified: boolean; }
export interface VerificationRun {
    readonly targets: readonly ModelReference[];
    readonly results: readonly ModelOperationResult[];
    readonly running: boolean;
}

export function verificationPicker(models: readonly VerificationTarget[], onlyUnverified = true, selectedIndex = 0): TuiSettingsPickerState {
    const targets = models.filter((model) => !onlyUnverified || !model.verified);
    const scopes = [undefined, ...new Set(models.map((model) => model.provider))];
    const options = scopes.map((provider) => {
        const count = targets.filter((model) => provider === undefined || model.provider === provider).length;
        return { value: provider ?? "", label: provider === undefined ? "Entire library" : `${provider} library`,
            description: `${count} target${count === 1 ? "" : "s"}`, unavailable: count === 0 };
    });
    return { kind: "pool_verify_scope", title: "Verify library models", query: "", selectedIndex,
        verificationTargets: models, onlyUnverified,
        subtitle: `${onlyUnverified ? "Unverified models in your library" : "All models in your library"} · tab to change\n`
            + `${targets.length} model${targets.length === 1 ? "" : "s"} in your library to verify.`,
        allOptions: options, options };
}

export function handleVerificationKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey): TuiSettingsPickerTransition {
    if (key.name === "escape") return { state: state.parent, handled: true };
    if (tuiBindingId("verification_picker", key) === "verification_coverage" && state.verificationTargets !== undefined) return {
        state: { ...verificationPicker(state.verificationTargets, !state.onlyUnverified, state.selectedIndex), parent: state.parent }, handled: true };
    if (key.name === "up" || key.name === "down") return { state: { ...state,
        selectedIndex: Math.max(0, Math.min(state.options.length - 1, state.selectedIndex + (key.name === "up" ? -1 : 1))) }, handled: true };
    if ((key.name === "enter" || key.name === "return") && state.kind === "pool_verify_scope") {
        const row = state.options[state.selectedIndex];
        if (row !== undefined && row.unavailable !== true) return { state, handled: true,
            selection: { kind: "pool_verify_scope", onlyUnverified: state.onlyUnverified === true,
                ...(row.value === "" ? {} : { provider: row.value }) } };
    }
    return { state, handled: true };
}

export function verificationResults(run: VerificationRun, from?: TuiSettingsPickerState): TuiSettingsPickerState {
    const options = run.targets.map((target) => {
        const result = run.results.find((row) => row.provider === target.provider && row.model === target.model);
        return { value: `${target.provider}/${target.model}`, label: `${target.provider}/${target.model}`,
            description: `${result?.status ?? "waiting"}${result?.reason ? `: ${result.reason}` : ""}` };
    });
    return { kind: "model_verification", title: run.running ? "Verifying models" : "Verification results",
        subtitle: "Leaving this screen does not stop the checks.\nA failure changes no existing assignment.",
        allOptions: options, options,
        selectedIndex: from?.kind === "model_verification" ? Math.min(from.selectedIndex, Math.max(0, options.length - 1)) : 0,
        parent: from?.kind === "model_verification" ? from.parent : from,
        query: "" };
}

export function verificationNudge(models: readonly { readonly verified: boolean }[], dismissed: boolean): string | undefined {
    const count = models.filter((model) => !model.verified).length;
    return dismissed || count === 0 ? undefined
        : `${count} model${count === 1 ? "" : "s"} in your library ${count === 1 ? "hasn't" : "haven't"} been verified · Verify library ^⇧y · Not now ^⇧x`;
}
