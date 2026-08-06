import type { ModelReasoningEffort } from "../model/types.ts";

export interface SpawnModelChoice {
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

/**
 * The optional model override both spawn tools accept, validated once.
 *
 * Both fields are suggestions, and a spawn that names neither is the normal
 * case: it falls through to the configured subagent default and the ladder's
 * self logic. `null` and blank strings are read as "not given" rather than
 * rejected, because failing the call costs a whole model round trip to say
 * something the defaults already answer.
 */
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
