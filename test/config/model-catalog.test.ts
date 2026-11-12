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

test("a ladder of rungs parses with each rung's strategy, routes and timeout", () => {
    const routes = { summarizer: ["primary"] };
    expect(parseCompactionConfig(
        {
            ladder: [
                {
                    strategy: "vera/full-summary",
                    models: { summarizer: "summarizer" },
                    timeout_ms: 60_000,
                },
                { strategy: "vera/drop-oldest" },
            ],
            trigger_fraction: 0.2,
            target_tokens: 10_000,
        },
        routes,
    )).toEqual({
        ladder: [
            {
                strategy: "vera/full-summary",
                models: { summarizer: "summarizer" },
                timeout_ms: 60_000,
            },
            { strategy: "vera/drop-oldest" },
        ],
        trigger_fraction: 0.2,
        target_tokens: 10_000,
    });
});

test("a legacy strategy and models pair reads as a one-rung ladder", () => {
    const routes = { summarizer: ["primary"] };
    expect(parseCompactionConfig(
        {
            strategy: "vera/full-summary",
            models: { summarizer: "summarizer" },
            timeout_ms: 60_000,
            trigger_fraction: 0.2,
        },
        routes,
    )).toEqual({
        ladder: [{
            strategy: "vera/full-summary",
            models: { summarizer: "summarizer" },
            timeout_ms: 60_000,
        }],
        trigger_fraction: 0.2,
    });
});

test("a legacy strategy without models, or models without a strategy, leaves the block unparsed", () => {
    const routes = { summarizer: ["primary"] };
    for (const value of [
        { strategy: "vera/full-summary" },
        { models: { summarizer: "summarizer" } },
    ]) {
        expect(parseCompactionConfig(value, routes)).toBeUndefined();
    }
});

test("a legacy timeout with no strategy is checked and dropped", () => {
    const routes = { summarizer: ["primary"] };
    expect(parseCompactionConfig({ timeout_ms: 60_000 }, routes)).toEqual({});
    expect(parseCompactionConfig({ timeout_ms: 500 }, routes)).toBeUndefined();
});

test("a ladder alongside legacy keys leaves the block unparsed rather than merging", () => {
    const routes = { summarizer: ["primary"] };
    const rung = [{ strategy: "vera/drop-oldest" }];
    for (const value of [
        { ladder: rung, strategy: "vera/full-summary", models: { summarizer: "summarizer" } },
        { ladder: rung, timeout_ms: 60_000 },
    ]) {
        expect(parseCompactionConfig(value, routes)).toBeUndefined();
    }
});

test("malformed rungs leave the block unparsed", () => {
    const routes = { summarizer: ["primary"] };
    const cases: readonly unknown[] = [
        { ladder: [] },
        { ladder: "vera/full-summary" },
        { ladder: ["vera/drop-oldest"] },
        { ladder: [{}] },
        { ladder: [{ strategy: "drop-oldest" }] },
        { ladder: [{ strategy: "vera/drop-oldest", target_tokens: 5 }] },
        { ladder: [{ strategy: "vera/drop-oldest", reasoning_effort: "" }] },
        { ladder: [{ strategy: "vera/drop-oldest", reasoning_effort: 3 }] },
        { ladder: [{ strategy: "vera/full-summary", models: "summarizer" }] },
        { ladder: [{ strategy: "vera/full-summary", models: { summarizer: "nope" } }] },
        { ladder: [{ strategy: "vera/drop-oldest", timeout_ms: 500 }] },
        { ladder: [{ strategy: "vera/drop-oldest" }, { strategy: "vera/drop-oldest", timeout_ms: 1.5 }] },
        { ladder: [{ strategy: "vera/drop-oldest" }], trigger_fraction: 2 },
    ];
    for (const value of cases) {
        expect(parseCompactionConfig(value, routes)).toBeUndefined();
    }
});

test("a rung's reasoning_effort is kept on that rung and resolves with it", () => {
    const catalog: VeraModelCatalogConfig = {
        models: [
            { name: "primary", provider: "ollama", model: "gemma4:26b" },
        ],
        model_routes: { summarizer: ["primary"] },
        reviewer_profiles: {},
    };
    const parsed = parseCompactionConfig(
        {
            ladder: [
                {
                    strategy: "vera/full-summary",
                    models: { summarizer: "summarizer" },
                    reasoning_effort: "low",
                },
                { strategy: "vera/drop-oldest" },
            ],
        },
        catalog.model_routes,
    );
    expect(parsed?.ladder).toEqual([
        {
            strategy: "vera/full-summary",
            models: { summarizer: "summarizer" },
            reasoning_effort: "low",
        },
        { strategy: "vera/drop-oldest" },
    ]);
    const resolved = resolveCompactionProfile(catalog, parsed!);
    expect(resolved?.ladder[0]?.reasoning_effort).toBe("low");
    expect(resolved?.ladder[1]?.reasoning_effort).toBeUndefined();
});

test("compaction trigger bounds parse, and defaults stay absent when unset", () => {
    const routes = { summarizer: ["primary"] };
    expect(parseCompactionConfig({}, routes)).toEqual({});
    expect(parseCompactionConfig(
        { trigger_fraction: 0.2, trigger_tokens: 30_000, target_tokens: 10_000 },
        routes,
    )).toEqual({ trigger_fraction: 0.2, trigger_tokens: 30_000, target_tokens: 10_000 });
});

test("out-of-range compaction trigger bounds are rejected", () => {
    const routes = { summarizer: ["primary"] };
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
        expect(parseCompactionConfig(trigger, routes)).toBeUndefined();
    }
});

test("a compaction block may carry numbers with no ladder", () => {
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

test("every rung resolves its own slot routes against the catalog", () => {
    const catalog: VeraModelCatalogConfig = {
        models: [
            { name: "primary", provider: "ollama", model: "gemma4:26b" },
        ],
        model_routes: { summarizer: ["primary"] },
        reviewer_profiles: {},
    };
    const parsed = parseCompactionConfig(
        {
            ladder: [
                { strategy: "vera/full-summary", models: { summarizer: "summarizer" } },
                { strategy: "vera/drop-oldest" },
            ],
        },
        catalog.model_routes,
    );
    const resolved = resolveCompactionProfile(catalog, parsed!);
    expect(resolved?.ladder.map((rung) => rung.strategy)).toEqual([
        "vera/full-summary",
        "vera/drop-oldest",
    ]);
    expect(resolved?.ladder[0]?.routes).toEqual({ summarizer: "summarizer" });
    expect(resolved?.ladder[0]?.slots.summarizer?.[0]?.name).toBe("primary");
    expect(resolved?.ladder[1]?.slots).toEqual({});
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
    ]) {
        expect(parseCompactionConfig(value, routes)).toBeUndefined();
    }
    expect(parseCompactionConfig(
        { trigger_fraction: 0.82, target_fraction: 0.45 },
        routes,
    )).toEqual({ trigger_fraction: 0.82, target_fraction: 0.45 });
    expect(parseCompactionConfig({ trigger_fraction: 0.2 }, routes))
        .toEqual({ trigger_fraction: 0.2 });
});

test("a target at or above the trigger loads, since compaction pulls it under", () => {
    const routes = { summarizer: ["primary"] };
    for (const value of [
        { trigger_fraction: 0.5, target_fraction: 0.5 },
        { trigger_fraction: 0.2, target_fraction: 0.9 },
        { target_fraction: 0.9 },
    ]) {
        expect(parseCompactionConfig(value, routes)).toEqual(value);
    }
});
