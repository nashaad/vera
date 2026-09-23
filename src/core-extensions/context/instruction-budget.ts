import type { JsonObject, JsonValue } from "../../sdk/hooks.ts";

export const DEFAULT_INSTRUCTION_BUDGET_TOKENS = 8_000;

export interface InstructionSource {
    readonly displayName: string;
    readonly estimatedTokens: number;
}

export interface InstructionBudget {
    readonly tokens: number;
    readonly budget: number;
    readonly over: boolean;
    readonly biggest?: InstructionSource;
}

// `tokens` is the INSTRUCTIONS section total, so the row, header, and warnings agree.
export function instructionBudget(
    tokens: number,
    sources: readonly InstructionSource[],
    budgetTokens: number = DEFAULT_INSTRUCTION_BUDGET_TOKENS,
): InstructionBudget {
    let biggest: InstructionSource | undefined;
    for (const source of sources) {
        if (biggest === undefined || source.estimatedTokens > biggest.estimatedTokens) {
            biggest = source;
        }
    }
    return {
        tokens,
        budget: budgetTokens,
        // 0 turns the budget off.
        over: budgetTokens > 0 && tokens >= budgetTokens,
        ...(biggest === undefined ? {} : { biggest }),
    };
}

// Reads `instruction_budget_tokens` from the extension's config; a bad value fails activation.
export function configuredInstructionBudget(config: JsonValue): number {
    if (config === null || config === undefined) return DEFAULT_INSTRUCTION_BUDGET_TOKENS;
    if (typeof config !== "object" || Array.isArray(config)) {
        throw new Error("vera.context config must be an object");
    }
    const value = (config as JsonObject).instruction_budget_tokens;
    if (value === undefined) return DEFAULT_INSTRUCTION_BUDGET_TOKENS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error("instruction_budget_tokens must be a whole number, 0 or more");
    }
    return value;
}
