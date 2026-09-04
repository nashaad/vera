import { expect, test } from "bun:test";

import {
    derivedModelName,
    parseCompactionConfig,
    parseModelCatalogConfig,
    resolveCompactionProfile,
    resolveReviewerProfile,
    type VeraModelCatalogConfig,
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

test("compaction trigger bounds parse, and defaults stay absent when unset", () => {
    const routes = { summarizer: ["primary"] };
    expect(parseCompactionConfig(
        { strategy: "vera/full-summary", models: { summarizer: "summarizer" } },
        routes,
    )).toEqual({
        strategy: "vera/full-summary",
        models: { summarizer: "summarizer" },
    });
    expect(parseCompactionConfig(
        {
            strategy: "vera/full-summary",
            models: { summarizer: "summarizer" },
            trigger_fraction: 0.2,
            trigger_tokens: 30_000,
            target_tokens: 10_000,
        },
        routes,
    )).toEqual({
        strategy: "vera/full-summary",
        models: { summarizer: "summarizer" },
        trigger_fraction: 0.2,
        trigger_tokens: 30_000,
        target_tokens: 10_000,
    });
});

test("out-of-range compaction trigger bounds are rejected", () => {
    const routes = { summarizer: ["primary"] };
    const base = {
        strategy: "vera/full-summary",
        models: { summarizer: "summarizer" },
    };
    for (const trigger of [
        { trigger_fraction: 0 },
        { trigger_fraction: 1.5 },
        { trigger_fraction: "0.5" },
        { trigger_tokens: 0 },
        { trigger_tokens: 1.5 },
        { trigger_tokens: "30000" },
        { target_tokens: 0 },
        { target_tokens: 1.5 },
        { target_tokens: "10000" },
    ]) {
        expect(parseCompactionConfig({ ...base, ...trigger }, routes))
            .toBeUndefined();
    }
});

test("a compaction block may carry numbers with no strategy", () => {
    const routes = { summarizer: ["primary"] };
    expect(parseCompactionConfig(
        {
            trigger_fraction: 0.7,
            target_fraction: 0.4,
            retained_user_turns: 3,
            min_summary_tokens: 500,
            max_attempts: 2,
            summary_word_cap: 2_000,
            assumed_window_tokens: 64_000,
            unknown_target_fraction: 0.3,
        },
        routes,
    )).toEqual({
        trigger_fraction: 0.7,
        target_fraction: 0.4,
        retained_user_turns: 3,
        min_summary_tokens: 500,
        max_attempts: 2,
        summary_word_cap: 2_000,
        assumed_window_tokens: 64_000,
        unknown_target_fraction: 0.3,
    });
    expect(parseCompactionConfig({}, routes)).toEqual({});
});

test("a strategy without routes, or routes without a strategy, is rejected", () => {
    const routes = { summarizer: ["primary"] };
    expect(parseCompactionConfig({ strategy: "vera/full-summary" }, routes))
        .toBeUndefined();
    expect(parseCompactionConfig({ models: { summarizer: "summarizer" } }, routes))
        .toBeUndefined();
});

test("a numbers-only compaction block resolves to no profile", () => {
    const catalog: VeraModelCatalogConfig = {
        models: [
            { name: "primary", provider: "ollama", model: "gemma4:26b" },
        ],
        model_routes: { summarizer: ["primary"] },
        reviewer_profiles: {},
    };
    const parsed = parseCompactionConfig(
        { trigger_fraction: 0.7 },
        catalog.model_routes,
    );
    expect(parsed).toEqual({ trigger_fraction: 0.7 });
    expect(resolveCompactionProfile(catalog, parsed!)).toBeUndefined();
});

test("out-of-range compaction numbers are rejected", () => {
    const routes = { summarizer: ["primary"] };
    // The control: without it every case below passes on a parser that
    // rejects everything.
    expect(parseCompactionConfig({ target_fraction: 0.4 }, routes))
        .toEqual({ target_fraction: 0.4 });
    for (const value of [
        { target_fraction: 0 },
        { target_fraction: 1.5 },
        { target_fraction: "0.4" },
        { unknown_target_fraction: 0 },
        { unknown_target_fraction: 1.5 },
        { min_summary_tokens: 0 },
        { min_summary_tokens: 1.5 },
        { max_attempts: 0 },
        { max_attempts: 2.5 },
        { summary_word_cap: 0 },
        { summary_word_cap: "2000" },
        { assumed_window_tokens: 0 },
        { assumed_window_tokens: 1.5 },
        { min_summary_tokens: Number.MAX_SAFE_INTEGER + 1 },
        { assumed_window_tokens: Number.MAX_SAFE_INTEGER + 1 },
        // A summary aimed at or above the point that triggers one.
        { trigger_fraction: 0.5, target_fraction: 0.5 },
        { trigger_fraction: 0.2, target_fraction: 0.9 },
        // Alone, the target is measured against the standing trigger of 0.82.
        { target_fraction: 0.9 },
        { target_fraction: 0.82 },
    ]) {
        expect(parseCompactionConfig(value, routes)).toBeUndefined();
    }
    expect(parseCompactionConfig(
        { trigger_fraction: 0.82, target_fraction: 0.45 },
        routes,
    )).toEqual({ trigger_fraction: 0.82, target_fraction: 0.45 });
    // A trigger set alone keeps parsing whatever it is. Measuring it against
    // the standing target would reject blocks that load today.
    expect(parseCompactionConfig({ trigger_fraction: 0.2 }, routes))
        .toEqual({ trigger_fraction: 0.2 });
});
