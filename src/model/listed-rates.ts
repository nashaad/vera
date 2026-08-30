import type { ModelPricing } from "./catalog-shape.ts";

/**
 * OpenRouter listed in/out as `3/15`, with no dollar sign. Absent pricing is
 * a blank cell, never a guessed free model.
 */
export function formatListedRates(
    pricing: ModelPricing | undefined,
): string | undefined {
    if (pricing === undefined) {
        return undefined;
    }
    return `${formatListedRate(pricing.input)}/${formatListedRate(pricing.output)}`;
}

/**
 * AA-style blend of listed cache-hit, input, and output at 7:2:1, USD per
 * million, no dollar sign. A missing cache-hit rate uses the listed input
 * rate (no discount), not a guessed cache price from another board.
 */
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
