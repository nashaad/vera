import type { ModelReasoningEffort } from "../model/types.ts";
import {
    loadSupportedModelsCatalog,
    verifiedReasoningEfforts,
    type SuggestedModel,
} from "../model/supported-models.ts";

export interface ModelTurnSettings {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly availableReasoningEfforts?: readonly ModelReasoningEffort[];
    readonly availableModels?: readonly SuggestedModel[];
    readonly contextWindow?: number;
}

export interface ModelSettingsPatch {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort | null;
}

export function isModelTurnSettings(value: unknown): value is ModelTurnSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const settings = value as Record<string, unknown>;
    return (settings.provider === undefined
            || (typeof settings.provider === "string"
                && settings.provider.trim().length > 0))
        && typeof settings.model === "string"
        && settings.model.trim().length > 0
        && (settings.reasoningEffort === undefined
            || isModelReasoningEffort(settings.reasoningEffort))
        && (settings.availableReasoningEfforts === undefined
            || (Array.isArray(settings.availableReasoningEfforts)
                && settings.availableReasoningEfforts.every(isModelReasoningEffort)))
        && (settings.availableModels === undefined
            || (Array.isArray(settings.availableModels)
                && settings.availableModels.every(isSuggestedModel)))
        && (settings.contextWindow === undefined
            || (Number.isSafeInteger(settings.contextWindow)
                && (settings.contextWindow as number) > 0));
}

export function availableReasoningEfforts(
    provider: string,
    model: string,
): readonly ModelReasoningEffort[] {
    const verified = verifiedReasoningEfforts(provider, model);
    return verified.length > 0
        ? verified
        : ["off", "low", "medium", "high", "max"];
}

export function availableModels(): readonly SuggestedModel[] {
    return loadSupportedModelsCatalog().verified_models
        .map((model) => ({
            provider: model.provider,
            model: model.model,
            label: model.label,
            description: model.description,
            contextWindow: model.context_window,
        }));
}

function isSuggestedModel(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const model = value as Record<string, unknown>;
    return typeof model.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && typeof model.description === "string"
        && (model.contextWindow === undefined
            || (Number.isSafeInteger(model.contextWindow)
                && (model.contextWindow as number) > 0));
}

export function isModelReasoningEffort(
    value: unknown,
): value is ModelReasoningEffort {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}
