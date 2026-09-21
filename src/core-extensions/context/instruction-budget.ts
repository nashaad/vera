export const INSTRUCTION_BUDGET_TOKENS = 5_000;

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
): InstructionBudget {
    let biggest: InstructionSource | undefined;
    for (const source of sources) {
        if (biggest === undefined || source.estimatedTokens > biggest.estimatedTokens) {
            biggest = source;
        }
    }
    return {
        tokens,
        budget: INSTRUCTION_BUDGET_TOKENS,
        over: tokens >= INSTRUCTION_BUDGET_TOKENS,
        ...(biggest === undefined ? {} : { biggest }),
    };
}
