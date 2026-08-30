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

test("a unique exact last-segment hit joins, and glm-5.2 does not take glm-5.2-max", () => {
    expect(joinWaScore({
        provider: "openrouter",
        model: "other/glm-5.1",
    }, snapshot, aliases)).toBe(1400);
    expect(joinWaScore({
        provider: "openrouter",
        model: "other/glm-5.2",
    }, snapshot, aliases)).toBeUndefined();
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
