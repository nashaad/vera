import type { ModelReasoningEffort } from "../model/types.ts";

export interface SpawnModelChoice {
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export function spawnModelChoice(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
): SpawnModelChoice {
    const model = optionalText(toolName, "model", input.model);
    const reasoningEffort = optionalText(
        toolName,
        "reasoning_effort",
        input.reasoning_effort,
    );
    return {
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
}

function optionalText(
    toolName: string,
    field: string,
    value: unknown,
): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new Error(
            `${toolName} tool requires ${field} to be a string`,
        );
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}
