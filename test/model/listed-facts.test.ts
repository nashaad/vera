import { expect, test } from "bun:test";

import { withListedFacts } from "../../src/model/listed-facts.ts";
import type { AvailableModel, PooledModel } from "../../src/model/catalog-view.ts";
import type { WebDevArenaSnapshot } from "../../src/model/webdev-arena.ts";

const aliases = {
    schema_version: 1 as const,
    aliases: {
        "openrouter/front": "front-max",
        "openrouter/folded": "folded-max",
    },
};

const snapshot: WebDevArenaSnapshot = {
    schema_version: 1,
    source: "lmarena-ai/leaderboard-dataset",
    config: "webdev",
    split: "latest",
    license: "CC-BY-4.0",
    fetched_at: "2026-08-29T00:00:00Z",
    leaderboard_publish_date: "2026-08-21",
    rows: [
        { model_name: "front-max", rating: 1600, category: "overall" },
        { model_name: "folded-max", rating: 1500, category: "overall" },
    ],
};

function available(
    model: string,
    extras: Partial<AvailableModel> = {},
): AvailableModel {
    return {
        provider: "openrouter",
        model,
        label: model,
        description: "a model",
        levels: [],
        ...extras,
    };
}

function pooled(
    model: string,
    extras: Partial<PooledModel> = {},
): PooledModel {
    return {
        provider: "openrouter",
        model,
        label: model,
        available: true,
        verified: true,
        levels: [],
        ...extras,
    };
}

test("P is stamped once over the union, including folded rows", () => {
    const listed = withListedFacts(
        [
            available("front", {
                pricing: { input: 3, output: 15 },
                hiddenByDefault: "old",
            }),
        ],
        [
            pooled("folded", { pricing: { input: 1, output: 1 } }),
            pooled("score-only"),
        ],
        { snapshot, aliases },
    );

    expect(listed.available[0]?.waScore).toBe(1600);
    expect(listed.available[0]?.onPareto).toBe(true);
    expect(listed.pooled[0]?.waScore).toBe(1500);
    expect(listed.pooled[0]?.onPareto).toBe(true);
    expect(listed.pooled[1]?.waScore).toBeUndefined();
    expect(listed.pooled[1]?.onPareto).toBeUndefined();
    expect(listed.webdevArenaSnapshot).toBe("2026-08-21");
});

test("a missing score or missing rate never becomes 0 or P", () => {
    const listed = withListedFacts(
        [available("unknown", { pricing: { input: 3, output: 15 } })],
        [pooled("unpriced", { waScore: 1600 })],
        { snapshot, aliases },
    );

    expect(listed.available[0]?.waScore).toBeUndefined();
    expect(listed.available[0]?.onPareto).toBeUndefined();
    expect(listed.pooled[0]?.onPareto).toBeUndefined();
});
