import type { ModelReasoningEffort } from "../model/types.ts";

export interface ModelTurnSettings {
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ModelSettingsPatch {
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort | null;
}
