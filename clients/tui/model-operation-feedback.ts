import type { ModelOperation, ModelOperationResult } from "../../src/model/model-operations.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { TuiSettingsPickerState } from "./settings-picker-types.ts";

type Feedback = NonNullable<TuiSettingsPickerState["journeyFeedback"]>;

export function shortlistOperationFeedback(
    operation: ModelOperation,
    label: string,
    results: readonly ModelOperationResult[],
    settings: ModelTurnSettings | undefined,
    error?: string,
): Feedback {
    const failed = results.find((result) => result.status === "failed");
    if (error !== undefined || failed !== undefined) return {
        status: "error", message: error ?? failed?.reason ?? "Could not update library.",
    };
    const confirmed = operation.models.every((model) => {
        if (results.some((result) => result.provider === model.provider && result.model === model.model && result.status === "passed")) return true;
        if (settings?.pooled === undefined) return false;
        const kept = settings.pooled.some((entry) => entry.provider === model.provider && entry.model === model.model);
        return operation.operation === "keep" ? kept : !kept;
    });
    if (!confirmed) return { status: "error", message: "Could not confirm the library change." };
    const subject = operation.models.length === 1 ? label : `${operation.models.length} models`;
    return { status: "success", membership: operation.operation === "keep" ? "added" : "removed", message: `${subject} ${operation.operation === "keep" ? "added to" : "removed from"} library` };
}

export function replaceJourneyFeedback(state: TuiSettingsPickerState, pending: Feedback, feedback: Feedback): TuiSettingsPickerState {
    const parent = state.parent === undefined ? undefined : replaceJourneyFeedback(state.parent, pending, feedback);
    if (state.journeyFeedback !== pending && parent === state.parent) return state;
    return { ...state, parent, journeyFeedback: state.journeyFeedback === pending ? feedback : state.journeyFeedback };
}
