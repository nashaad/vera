import { expect, test } from "bun:test";

import {
    derivedModelName,
    parseModelCatalogConfig,
    resolveReviewerProfile,
} from "../../src/config/model-catalog.ts";

test("model names derive from concrete settings unless explicitly named", () => {
    expect(derivedModelName(
        "openrouter",
        "anthropic/claude-opus-4.8",
        "max",
    )).toBe("anthropic_claude_opus_4_8_max_openrouter");

    const config = parseModelCatalogConfig(
        [
            {
                provider: "openrouter",
                model: "anthropic/claude-opus-4.8",
                reasoning_effort: "max",
            },
            {
                name: "banana",
                provider: "openai-codex",
                model: "gpt-5.6-sol",
                reasoning_effort: "high",
            },
        ],
        {
            careful_review: [
                "anthropic_claude_opus_4_8_max_openrouter",
                "banana",
            ],
        },
        {
            default: {
                model_route: "careful_review",
                policy: "Approve ordinary actions that follow from the request.",
            },
        },
    );

    expect(config).toBeDefined();
    expect(config?.models.map((model) => model.name)).toEqual([
        "anthropic_claude_opus_4_8_max_openrouter",
        "banana",
    ]);
});

test("reviewer profiles resolve one ordered model route", () => {
    const config = parseModelCatalogConfig(
        [
            {
                name: "primary",
                provider: "openrouter",
                model: "anthropic/claude-opus-4.8",
                reasoning_effort: "max",
            },
            {
                name: "fallback",
                provider: "ollama",
                model: "gemma4:26b",
            },
        ],
        { review: ["primary", "fallback"] },
        {
            default: {
                model_route: "review",
                policy: "Allow routine work.",
                timeout_ms: 45_000,
            },
        },
    );
    if (config === undefined) {
        throw new Error("Expected valid model catalog");
    }

    expect(resolveReviewerProfile(config, "default")).toEqual({
        name: "default",
        policy: "Allow routine work.",
        timeout_ms: 45_000,
        models: [
            {
                name: "primary",
                provider: "openrouter",
                model: "anthropic/claude-opus-4.8",
                reasoning_effort: "max",
            },
            {
                name: "fallback",
                provider: "ollama",
                model: "gemma4:26b",
            },
        ],
    });
});

test("catalog validation rejects broken routes and reviewer references", () => {
    const model = [{
        name: "primary",
        provider: "openrouter",
        model: "anthropic/claude-opus-4.8",
    }];
    expect(parseModelCatalogConfig(
        model,
        { review: ["missing"] },
        {},
    )).toBeUndefined();
    expect(parseModelCatalogConfig(
        model,
        { review: ["primary"] },
        {
            default: {
                model_route: "missing",
                policy: "Allow routine work.",
            },
        },
    )).toBeUndefined();
});

test("duplicate final model names are rejected even when configs match", () => {
    expect(parseModelCatalogConfig(
        [
            {
                provider: "ollama",
                model: "gemma4:26b",
            },
            {
                provider: "ollama",
                model: "gemma4:26b",
            },
        ],
        {},
        {},
    )).toBeUndefined();
});
