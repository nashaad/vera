export const DEFAULT_MAX_CONCURRENT_CHILD_AGENTS = 4;

export function validChildAgentLimit(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
            "Maximum concurrent child agents must be a positive integer",
        );
    }
    return value;
}
