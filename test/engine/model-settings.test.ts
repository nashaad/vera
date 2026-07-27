import { expect, test } from "bun:test";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import {
    availableReasoningEfforts,
    isModelTurnSettings,
    reasoningEffortForModel,
} from "../../src/engine/model-settings.ts";

const EVERY_EFFORT: readonly ModelReasoningEffort[] = [
    "off",
    "low",
    "medium",
    "high",
    "max",
];

test("a codex model with no verified catalog entry offers no efforts", () => {
    // A codex model has no known level list until a catalog loader supplies
    // one (a later slice); asking would fail the turn rather than degrade
    // it, so such a model has nothing to offer in the meantime.
    expect(availableReasoningEfforts("openai-codex", "gpt-5.6-codex"))
        .toEqual([]);
    expect(availableReasoningEfforts("openai-codex", "gpt-5.6-sol"))
        .toEqual([]);
});

test("providers that can infer an effort keep the optimistic list", () => {
    // OpenRouter looks an unknown model up and infers a level, and the Ollama
    // profile maps every effort itself, so neither can be asked for something
    // it cannot answer.
    expect(availableReasoningEfforts("openrouter", "vendor/unlisted-model"))
        .toEqual(EVERY_EFFORT);
    expect(availableReasoningEfforts("ollama", "gemma3")).toEqual(EVERY_EFFORT);
});

test("a model the user did not choose keeps any effort it can resolve", () => {
    // The menu a person is shown is narrower than what the adapter can do, and
    // a fallback or a config default is not a menu choice. Only a model that
    // can be asked for nothing loses the dial.
    expect(reasoningEffortForModel("openai-codex", "gpt-5.6-codex", "high"))
        .toBeUndefined();
    expect(reasoningEffortForModel("openai-codex", "gpt-5.6-sol", "high"))
        .toBeUndefined();

    // OpenRouter infers a level the catalog entry does not list, so a narrow
    // verified list must not read as an adapter limit.
    const narrow = availableReasoningEfforts("openrouter", "moonshotai/kimi-k3");
    const unlisted = EVERY_EFFORT.find((effort) => !narrow.includes(effort));
    expect(unlisted).toBeDefined();
    expect(reasoningEffortForModel("openrouter", "moonshotai/kimi-k3", unlisted))
        .toBe(unlisted);
});

test("settings validation accepts the stash and per-model levels", () => {
    const available = {
        provider: "test",
        model: "with-levels",
        label: "With levels",
        description: "a model",
        levels: [{ id: "high", label: "High" }],
        defaultLevel: "high",
    };
    const stashed = {
        provider: "test",
        model: "kept",
        label: "kept",
        available: false,
        levels: [],
    };

    expect(isModelTurnSettings({
        model: "with-levels",
        availableModels: [available],
        stash: [stashed],
    })).toBe(true);
    // An empty level list is a fact about the model, not a missing field.
    expect(isModelTurnSettings({
        model: "with-levels",
        availableModels: [{ ...available, levels: [], defaultLevel: undefined }],
    })).toBe(true);
    expect(isModelTurnSettings({ model: "with-levels", stash: [] })).toBe(true);
});

test("settings validation rejects entries missing their new fields", () => {
    expect(isModelTurnSettings({
        model: "with-levels",
        availableModels: [{
            provider: "test",
            model: "with-levels",
            label: "With levels",
            description: "a model",
        }],
    })).toBe(false);
    expect(isModelTurnSettings({
        model: "with-levels",
        stash: [{
            provider: "test",
            model: "kept",
            label: "kept",
            levels: [],
        }],
    })).toBe(false);
    expect(isModelTurnSettings({
        model: "with-levels",
        stash: [{
            provider: "test",
            model: "kept",
            label: "kept",
            available: true,
            levels: [{ label: "High" }],
        }],
    })).toBe(false);
});

test("a verified catalog entry still wins over the provider rule", () => {
    const verified = availableReasoningEfforts(
        "openrouter",
        "moonshotai/kimi-k3",
    );

    expect(verified.length).toBeGreaterThan(0);
    expect(verified).not.toEqual(EVERY_EFFORT);
});
