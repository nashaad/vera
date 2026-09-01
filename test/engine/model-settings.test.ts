import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import {
    availableReasoningEfforts,
    effectiveContextWindow,
    budgetContextWindow,
    isModelTurnSettings,
    reasoningEffortForModel,
} from "../../src/engine/model-settings.ts";

test("a global context limit caps declared windows and leaves unknown ones unknown", () => {
    expect(effectiveContextWindow(1_048_576, 204_800)).toBe(204_800);
    expect(effectiveContextWindow(131_072, 204_800)).toBe(131_072);
    expect(effectiveContextWindow(1_048_576, undefined)).toBe(1_048_576);
    expect(effectiveContextWindow(undefined, 204_800)).toBeUndefined();
    expect(budgetContextWindow(undefined, 204_800)).toBe(204_800);
    expect(budgetContextWindow(32_768, 204_800)).toBe(32_768);
    expect(budgetContextWindow(32_768, 8_192)).toBe(8_192);
});

const EVERY_EFFORT: readonly ModelReasoningEffort[] = [
    "low",
    "medium",
    "high",
    "max",
];

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

/**
 * A cache directory of its own, so these assertions describe Vera rather than
 * whichever providers the machine running the suite happens to have discovered.
 */
function cacheDir(snapshots: Record<string, unknown> = {}): {
    readonly cacheDir: string;
} {
    const directory = mkdtempSync(join(tmpdir(), "vera-model-settings-"));
    directories.push(directory);
    for (const [provider, models] of Object.entries(snapshots)) {
        writeFileSync(
            join(directory, `${provider}.json`),
            JSON.stringify({
                schema_version: 2,
                provider,
                fetched_at: "2026-07-27T00:00:00Z",
                models,
            }),
        );
    }
    return { cacheDir: directory };
}

test("a codex model nothing has described offers no efforts", () => {
    // Neither source knows this model's level list, and codex cannot infer one,
    // so asking would fail the turn rather than degrade it.
    const empty = cacheDir();
    expect(availableReasoningEfforts("openai-codex", "gpt-5.6-codex", empty))
        .toEqual([]);
    expect(availableReasoningEfforts("openai-codex", "gpt-5.6-sol", empty))
        .toEqual([]);
});

test("a codex model discovery described offers the levels it found", () => {
    // The picker offers these levels from the same snapshot. The two disagreeing
    // is what refused a level the user had just been shown as available.
    const options = cacheDir({
        "openai-codex": [{
            id: "gpt-5.6-sol",
            label: "GPT-5.6 Sol",
            levels: [
                { id: "xhigh", label: "Extra high" },
                { id: "high", label: "High" },
                { id: "low", label: "Low" },
            ],
        }],
    });

    expect(availableReasoningEfforts("openai-codex", "gpt-5.6-sol", options))
        .toEqual(["xhigh", "high", "low"]);
    expect(
        reasoningEffortForModel("openai-codex", "gpt-5.6-sol", "low", options),
    ).toBe("low");
});

test("providers that can infer an effort keep the optimistic list", () => {
    // OpenRouter looks an unknown model up and infers a level, and the Ollama
    // profile maps every effort itself, so neither can be asked for something
    // it cannot answer.
    const empty = cacheDir();
    expect(availableReasoningEfforts("openrouter", "vendor/unlisted", empty))
        .toEqual(EVERY_EFFORT);
    expect(availableReasoningEfforts("ollama", "gemma3", empty))
        .toEqual(EVERY_EFFORT);
});

test("a custom endpoint does not advertise a six-rung dial from silence", () => {
    const empty = cacheDir();
    expect(availableReasoningEfforts("unsloth-local", "unsloth/Qwen3.6", empty))
        .toEqual([]);
    expect(reasoningEffortForModel(
        "unsloth-local",
        "unsloth/Qwen3.6",
        "max",
        empty,
    )).toBeUndefined();
});

test("explicit catalog levels are the graded map a custom endpoint may offer", () => {
    const options = cacheDir({
        "unsloth-local": [{
            id: "mystery-reasoner",
            label: "Mystery",
            levels: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
            ],
        }],
    });
    expect(availableReasoningEfforts("unsloth-local", "mystery-reasoner", options))
        .toEqual(["low", "medium", "high"]);
    expect(reasoningEffortForModel(
        "unsloth-local",
        "mystery-reasoner",
        "low",
        options,
    )).toBe("low");
});

test("gpt-oss on a custom URL takes overlay vocabulary over a snapshot stamp", () => {
    const options = cacheDir({
        "unsloth-local": [{
            id: "gpt-oss",
            label: "gpt-oss",
            levels: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
            ],
        }],
    });
    expect(availableReasoningEfforts("unsloth-local", "gpt-oss", options))
        .toEqual(["high", "medium", "low"]);
});

test("a model the user did not choose keeps any effort it can resolve", () => {
    // The menu a person is shown is narrower than what the adapter can do, and
    // a fallback or a config default is not a menu choice. Only a model that
    // can be asked for nothing loses the dial.
    const empty = cacheDir();
    expect(
        reasoningEffortForModel("openai-codex", "gpt-5.6-codex", "high", empty),
    ).toBeUndefined();
    expect(
        reasoningEffortForModel("openai-codex", "gpt-5.6-sol", "high", empty),
    ).toBeUndefined();

    // OpenRouter infers a level the catalog entry does not list, so a narrow
    // verified list must not read as an adapter limit.
    const narrow = availableReasoningEfforts(
        "openrouter",
        "moonshotai/kimi-k3",
        empty,
    );
    const unlisted = EVERY_EFFORT.find((effort) => !narrow.includes(effort));
    expect(unlisted).toBeDefined();
    expect(reasoningEffortForModel(
        "openrouter",
        "moonshotai/kimi-k3",
        unlisted,
        empty,
    )).toBe(unlisted);
});

test("settings validation accepts the pool and per-model levels", () => {
    const available = {
        provider: "test",
        model: "with-levels",
        label: "With levels",
        description: "a model",
        levels: [{ id: "high", label: "High" }],
        defaultLevel: "high",
    };
    const pooled = {
        provider: "test",
        model: "kept",
        label: "kept",
        available: false,
        verified: false,
        levels: [],
    };

    expect(isModelTurnSettings({
        model: "with-levels",
        availableModels: [available],
        pooled: [pooled],
    })).toBe(true);
    // An empty level list is a fact about the model, not a missing field.
    expect(isModelTurnSettings({
        model: "with-levels",
        availableModels: [{ ...available, levels: [], defaultLevel: undefined }],
    })).toBe(true);
    expect(isModelTurnSettings({ model: "with-levels", pooled: [] })).toBe(true);
    expect(isModelTurnSettings({
        model: "with-levels",
        refreshableProviders: ["empty-gateway"],
    })).toBe(true);
    expect(isModelTurnSettings({
        model: "with-levels",
        availableModels: [{
            ...available,
            pricing: { input: 3, output: 15 },
            waScore: 1629,
            onPareto: true,
            imageSupport: true,
        }],
        webdevArenaSnapshot: "2026-08-21",
    })).toBe(true);
    // Listed facts are optional: a snapshot without them is still valid.
    expect(isModelTurnSettings({
        model: "with-levels",
        availableModels: [available],
    })).toBe(true);
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
        pooled: [{
            provider: "test",
            model: "kept",
            label: "kept",
            verified: true,
            levels: [],
        }],
    })).toBe(false);
    expect(isModelTurnSettings({
        model: "with-levels",
        pooled: [{
            provider: "test",
            model: "kept",
            label: "kept",
            available: true,
            levels: [],
        }],
    })).toBe(false);
    expect(isModelTurnSettings({
        model: "with-levels",
        pooled: [{
            provider: "test",
            model: "kept",
            label: "kept",
            available: true,
            verified: true,
            levels: [{ label: "High" }],
        }],
    })).toBe(false);
    expect(isModelTurnSettings({
        model: "with-levels",
        refreshableProviders: [""],
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
