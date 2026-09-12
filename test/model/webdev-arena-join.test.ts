import { expect, test } from "bun:test";

import { joinWaScore } from "../../src/model/webdev-arena-join.ts";
import type { WebDevArenaSnapshot } from "../../src/model/webdev-arena.ts";

const aliases = {
    schema_version: 1 as const,
    aliases: {
        "openrouter/anthropic/claude-opus-5": "claude-opus-5-max",
        "openrouter/anthropic/claude-opus-5@max": "claude-opus-5-max",
        "openrouter/z-ai/glm-5.2": "glm-5.2-max",
    },
};

const snapshot: WebDevArenaSnapshot = {
    schema_version: 1,
    source: "lmarena-ai/leaderboard-dataset",
    config: "webdev",
    split: "latest",
    license: "CC-BY-4.0",
    fetched_at: "2026-08-29T00:00:00Z",
    rows: [
        {
            model_name: "claude-opus-5-max",
            rating: 1690.639,
            category: "overall",
        },
        {
            model_name: "glm-5.1",
            rating: 1400.2,
            category: "overall",
        },
        {
            model_name: "glm-5.2-max",
            rating: 1510.4,
            category: "overall",
        },
        {
            model_name: "glm-5.2-max",
            rating: 9,
            category: "webdev",
        },
    ],
};

const variants: WebDevArenaSnapshot = {
    ...snapshot,
    rows: [
        { model_name: "gemini-3.8-flash-high", rating: 1568.2, category: "overall" },
        { model_name: "gemini-3.8-flash-lite", rating: 1100.4, category: "overall" },
        { model_name: "muse-spark-1.2 (xHigh)", rating: 1534.2, category: "overall" },
        { model_name: "muse-spark-1.3 (xHigh)", rating: 1625.1, category: "overall" },
        { model_name: "muse-spark-1.3-max", rating: 1649.9, category: "overall" },
        { model_name: "gpt-5.6-sol-xhigh (codex-harness)", rating: 1617.1, category: "overall" },
        { model_name: "gpt-5.1-codex", rating: 1336.4, category: "overall" },
        { model_name: "glm-5.3-max", rating: 1612.5, category: "overall" },
        { model_name: "glm-5.3-flash", rating: 1604.5, category: "overall" },
        { model_name: "qwen3.8-flash-next", rating: 1630.5, category: "overall" },
        { model_name: "qwen3.7-max-20260517", rating: 1516.9, category: "overall" },
    ],
};

test("an alias hit returns the overall rating rounded to an integer", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
    }, snapshot, aliases)).toBe(1691);
    expect(joinWaScore({
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
        recommendedLevel: "max",
    }, snapshot, aliases)).toBe(1691);
});

test("a unique exact last-segment hit joins", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "other/glm-5.1",
    }, snapshot, aliases)).toBe(1400);
});

test("a bare id takes the only rung the leaderboard ran", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "other/glm-5.2",
    }, snapshot, aliases)).toBe(1510);
    expect(joinWaScore({
        provider: "openrouter",
        model: "google/gemini-3.8-flash",
    }, variants, aliases)).toBe(1568);
});

test("a parenthesized rung and a codex-harness marker both fold away", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "meta/muse-spark-1.2",
    }, variants, aliases)).toBe(1534);
    expect(joinWaScore({
        provider: "openrouter",
        model: "openai/gpt-5.6-sol",
    }, variants, aliases)).toBe(1617);
});

test("several rungs resolve to the recommended one, else the ceiling", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "meta/muse-spark-1.3",
        recommendedLevel: "xhigh",
    }, variants, aliases)).toBe(1625);
    expect(joinWaScore({
        provider: "openrouter",
        model: "meta/muse-spark-1.3",
    }, variants, aliases)).toBe(1650);
});

test("an exact row wins over a folded one", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "z-ai/glm-5.3-flash",
    }, variants, aliases)).toBe(1605);
});

test("a rung word inside a model id is not folded off the id", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "openai/gpt-5.1-codex-max",
    }, variants, aliases)).toBeUndefined();
});

test("a name part the leaderboard did not add stays unmatched", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "qwen/qwen3.8-flash",
    }, variants, aliases)).toBeUndefined();
    expect(joinWaScore({
        provider: "openrouter",
        model: "qwen/qwen3.7-max",
    }, variants, aliases)).toBeUndefined();
});

test("an unmatched row is undefined, never 0", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "unknown/model",
    }, snapshot, aliases)).toBeUndefined();
    expect(joinWaScore({
        provider: "openrouter",
        model: "anthropic/claude-opus-5",
    }, undefined, aliases)).toBeUndefined();
});

test("non-overall rows are ignored even when the name matches", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "z-ai/glm-5.2",
    }, snapshot, aliases)).toBe(1510);
});
