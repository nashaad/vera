import { nearestEffort } from "../model/effort-ladder.ts";
import type { ModelReasoningEffort } from "../model/types.ts";
import type { ModelTurnSettings } from "./model-settings.ts";
import type { ToolReviewerModelSettings } from "./reviewer.ts";

export function reviewerFallbackModel(
    current: ModelTurnSettings,
    preferredEffort: ModelReasoningEffort | undefined,
    offeredLevels: readonly ModelReasoningEffort[] | undefined = current.availableReasoningEfforts,
): ToolReviewerModelSettings {
    const effort = preferredEffort === undefined
        ? current.reasoningEffort
        : nearestEffort(preferredEffort, offeredLevels ?? []);
    return {
        model: current.model,
        ...(current.provider === undefined ? {} : { provider: current.provider }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
}
