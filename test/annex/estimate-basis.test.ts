import { expect, test } from "bun:test";

import { hasEstimatedSpend } from "../../clients/annex/estimate-basis.ts";

const noEstimate = {
    estimatedFromOpenRouter: false,
    totals: { spend: { estimated: 0 } },
    models: [{ provider: "local", model: "one", kind: "mixed" as const }],
};

test("the blended rate basis is reported when no calls were estimated", () => {
    expect(hasEstimatedSpend(noEstimate)).toBe(false);
    expect(hasEstimatedSpend({
        ...noEstimate,
        models: [{ provider: "deepseek", model: "unknown", kind: "mixed" }],
    })).toBe(false);
});

test("the blended rate basis detects OpenRouter and DeepSeek estimates", () => {
    expect(hasEstimatedSpend({ ...noEstimate, estimatedFromOpenRouter: true })).toBe(true);
    expect(hasEstimatedSpend({ ...noEstimate, totals: { spend: { estimated: 1 } } })).toBe(true);
    expect(hasEstimatedSpend({
        ...noEstimate,
        models: [{ provider: "deepseek", model: "deepseek-flash", kind: "estimated" }],
    })).toBe(true);
});

