import { expect, test } from "bun:test";

import {
    loadSupportedModelsCatalog,
    verifiedModel,
    verifiedReasoningEfforts,
} from "../../src/model/supported-models.ts";

test("the supported catalog keeps provider and model as separate fields", () => {
    const catalog = loadSupportedModelsCatalog();

    expect(catalog.suggested_models.map(({ provider, model }) => ({
        provider,
        model,
    }))).toEqual([
        { provider: "openrouter", model: "moonshotai/kimi-k3" },
        { provider: "openrouter", model: "z-ai/glm-5.2" },
        { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
    ]);
});

test("verified combinations are resolved by provider and model together", () => {
    expect(verifiedReasoningEfforts("openrouter", "z-ai/glm-5.2"))
        .toEqual(["max", "high"]);
    expect(verifiedModel("anthropic", "z-ai/glm-5.2")).toBeUndefined();
});
