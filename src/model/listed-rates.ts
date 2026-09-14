import type { ModelPricing } from "./catalog-shape.ts";

/** Input to output weight of the blended price. */
export const BLENDED_RATIO = "3:1";

export function formatListedRates(
    pricing: ModelPricing | undefined,
): string | undefined {
    if (pricing === undefined) {
        return undefined;
    }
    return `${formatListedRate(pricing.input)}/${formatListedRate(pricing.output)}`;
}

export function blendedRate(
    pricing: ModelPricing | undefined,
): number | undefined {
    if (pricing === undefined) {
        return undefined;
    }
    return (3 * pricing.input + pricing.output) / 4;
}

export function formatBlendedRate(
    pricing: ModelPricing | undefined,
): string | undefined {
    const blended = blendedRate(pricing);
    return blended === undefined ? undefined : formatListedRate(blended);
}

function formatListedRate(value: number): string {
    const rounded = Math.round(value * 100) / 100;
    if (Number.isInteger(rounded)) {
        return String(rounded);
    }
    return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
