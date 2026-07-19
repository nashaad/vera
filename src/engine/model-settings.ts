import type { ModelReasoningEffort } from "../model/types.ts";

export interface ModelTurnSettings {
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
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
            || isModelReasoningEffort(settings.reasoningEffort));
}

function isModelReasoningEffort(value: unknown): boolean {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}
