import { tuiBindingId } from "./keymap.ts";
import type { ModelOperationResult, ModelOperationStep, ModelReference } from "../../src/model/model-operations.ts";
import { admissionStepMark } from "./state.ts";
import type { TuiSettingsPickerKey, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

export interface VerificationTarget extends ModelReference { readonly verified: boolean; }
export interface VerificationRun {
    readonly targets: readonly ModelReference[];
    readonly results: readonly ModelOperationResult[];
    readonly steps: readonly ModelOperationStep[];
    readonly running: boolean;
}

// The probe reports a step twice, running then settled, so the later report
// replaces the earlier one instead of stacking under it.
export function withVerificationStep(run: VerificationRun, step: ModelOperationStep): VerificationRun {
    const same = (row: ModelOperationStep) =>
        row.provider === step.provider && row.model === step.model && row.step === step.step;
    const at = run.steps.findIndex(same);
    return { ...run, steps: at === -1
        ? [...run.steps, step]
        : run.steps.map((row, index) => index === at ? step : row) };
}

export function verificationPicker(models: readonly VerificationTarget[], onlyUnverified = true, selectedIndex = 0): TuiSettingsPickerState {
    const targets = models.filter((model) => !onlyUnverified || !model.verified);
    const scopes = [undefined, ...new Set(models.map((model) => model.provider))];
    const options = scopes.map((provider) => {
        const count = targets.filter((model) => provider === undefined || model.provider === provider).length;
        return { value: provider ?? "", label: provider === undefined ? "All favorites" : `${provider} favorites`,
            description: `${count} target${count === 1 ? "" : "s"}`, unavailable: count === 0 };
    });
    return { kind: "pool_verify_scope", title: "Verify favorites", query: "", selectedIndex,
        verificationTargets: models, onlyUnverified,
        subtitle: `${onlyUnverified ? "Unverified favorites" : "All favorites"} · tab to change\n`
            + `${targets.length} favorite${targets.length === 1 ? "" : "s"} to verify.`,
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
    const options = run.targets.flatMap((target) => {
        const id = `${target.provider}/${target.model}`;
        const result = run.results.find((row) => row.provider === target.provider && row.model === target.model);
        const steps = run.steps.filter((row) => row.provider === target.provider && row.model === target.model);
        return [
            { value: id, label: id,
                description: `${result?.status ?? (steps.length > 0 ? "checking" : "waiting")}${result?.reason ? `: ${result.reason}` : ""}` },
            ...steps.map((step) => ({ value: `${id}#${step.step}`,
                label: `  ${admissionStepMark(step.status)} ${step.label}${step.status === "skipped" ? " (skipped)" : ""}`,
                description: step.detail ?? "" })),
        ];
    });
    return { kind: "model_verification", title: run.running ? "Verifying models" : "Verification results",
        subtitle: "Leaving this screen does not stop the checks.\nA failure changes no existing assignment.",
        allOptions: options, options,
        selectedIndex: from?.kind === "model_verification" ? Math.min(from.selectedIndex, Math.max(0, options.length - 1)) : 0,
        parent: from?.kind === "model_verification" ? from.parent : from,
        query: "" };
}
