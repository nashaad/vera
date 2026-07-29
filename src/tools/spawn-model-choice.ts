import type { ModelReasoningEffort } from "../model/types.ts";

export interface SpawnModelChoice {
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

/** The optional model override both spawn tools accept, validated once. */
export function spawnModelChoice(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
): SpawnModelChoice {
    const model = input.model;
    const reasoningEffort = input.reasoning_effort;
    if (
        model !== undefined
        && (typeof model !== "string" || model.trim().length === 0)
    ) {
        throw new Error(`${toolName} tool requires model to be a non-empty string`);
    }
    if (
        reasoningEffort !== undefined
        && (typeof reasoningEffort !== "string"
            || reasoningEffort.trim().length === 0)
    ) {
        throw new Error(
            `${toolName} tool requires reasoning_effort to be a non-empty string`,
        );
    }
    return {
        ...(model === undefined ? {} : { model: model.trim() }),
        ...(reasoningEffort === undefined
            ? {}
            : { reasoningEffort: reasoningEffort.trim() }),
    };
}
