import type { ModelReasoningEffort } from "../model/types.ts";

export interface ModelTurnSettings {
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly availableReasoningEfforts?: readonly ModelReasoningEffort[];
}

export interface ModelSettingsPatch {
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort | null;
}

export function isModelTurnSettings(value: unknown): value is ModelTurnSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const settings = value as Record<string, unknown>;
    return typeof settings.model === "string"
        && settings.model.trim().length > 0
        && (settings.reasoningEffort === undefined
            || isModelReasoningEffort(settings.reasoningEffort))
        && (settings.availableReasoningEfforts === undefined
            || (Array.isArray(settings.availableReasoningEfforts)
                && settings.availableReasoningEfforts.every(isModelReasoningEffort)));
}

export function availableReasoningEfforts(
    model: string,
): readonly ModelReasoningEffort[] {
    return model === "moonshotai/kimi-k3"
        ? ["max"]
        : ["off", "low", "medium", "high", "max"];
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
