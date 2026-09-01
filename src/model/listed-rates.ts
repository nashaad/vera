import type { ModelPricing } from "./catalog-shape.ts";

export function formatListedRates(
    pricing: ModelPricing | undefined,
): string | undefined {
    if (pricing === undefined) {
        return undefined;
    }
    return `${formatListedRate(pricing.input)}/${formatListedRate(pricing.output)}`;
}

export function formatBlendedRate(
    pricing: ModelPricing | undefined,
): string | undefined {
    if (pricing === undefined) {
        return undefined;
    }
    const cache = pricing.cache ?? pricing.input;
    const blended = (7 * cache + 2 * pricing.input + 1 * pricing.output) / 10;
    return formatListedRate(blended);
}

function formatListedRate(value: number): string {
    const rounded = Math.round(value * 100) / 100;
    if (Number.isInteger(rounded)) {
        return String(rounded);
    }
    return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
