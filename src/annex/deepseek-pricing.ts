import type { ModelUsage } from "../model/types.ts";

interface DeepSeekRates {
    readonly cachedInput: number;
    readonly input: number;
    readonly output: number;
}

const FLASH: DeepSeekRates = { cachedInput: 0.006, input: 0.30, output: 1.20 };
const PRO: DeepSeekRates = { cachedInput: 0.044, input: 1.32, output: 3.96 };

function ratesFor(model: string): DeepSeekRates | undefined {
    switch (model) {
        case "deepseek-flash":
        case "deepseek-v4-flash":
        case "deepseek-v4-flash-vision-exp":
            return FLASH;
        case "deepseek-v4-pro":
            return PRO;
        default:
            return undefined;
    }
}

export function estimateDeepSeekUsd(
    model: string,
    timestamp: string,
    usage: Pick<ModelUsage, "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteInputTokens">,
): number | undefined {
    const rates = ratesFor(model);
    const date = new Date(timestamp);
    if (rates === undefined || Number.isNaN(date.getTime())) return undefined;
    const day = date.getUTCDay();
    const hour = date.getUTCHours();
    const peak = day >= 1 && day <= 5
        && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    const cached = numeric(usage.cachedInputTokens);
    const written = numeric(usage.cacheWriteInputTokens);
    const uncached = Math.max(0, numeric(usage.inputTokens) - cached - written);
    const rate = peak ? 1 : 0.5;
    return rate * (
        (uncached + written) / 1e6 * rates.input
        + cached / 1e6 * rates.cachedInput
        + numeric(usage.outputTokens) / 1e6 * rates.output
    );
}

function numeric(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
