import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    FEED_FRESHNESS_MS,
    type FeedFetch,
    feedLearnedFacts,
    freshFeedRow,
    loadModelFeed,
    loadShippedModelFeed,
    parseModelFeed,
} from "../../src/model/feed-cache.ts";
import {
    feedRowForVerdict,
    type ModelFeed,
    type ModelFeedRow,
} from "../../src/model/feed-shape.ts";

const VERIFIED_AT = "2026-08-06T00:00:00.000Z";

function row(overrides: Partial<ModelFeedRow> = {}): ModelFeedRow {
    return {
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        verdict: "added",
        verified_levels: ["low", "high"],
        response_model: "qwen/qwen3-coder-480b",
        verified_at: VERIFIED_AT,
        ...overrides,
    };
}

function feed(models: readonly ModelFeedRow[]): ModelFeed {
    return {
        schema_version: 1,
        generated_at: VERIFIED_AT,
        models,
    };
}

function fetchAnswering(value: unknown): FeedFetch {
    return () =>
        Promise.resolve(
            new Response(JSON.stringify(value), { status: 200 }),
        );
}

test("a fetched feed with the known schema version is used", async () => {
    const result = await loadModelFeed({
        url: "https://example.test/feed.json",
        fetch: fetchAnswering(feed([row()])),
    });

    expect(result.source).toBe("fetched");
    expect(result.refusal).toBeUndefined();
    expect(result.feed?.models).toHaveLength(1);
});

test("an unknown schema version is refused and falls to the shipped copy", async () => {
    const result = await loadModelFeed({
        url: "https://example.test/feed.json",
        fetch: fetchAnswering({
            schema_version: 99,
            generated_at: VERIFIED_AT,
            models: [row()],
        }),
    });

    expect(result.source).toBe("shipped");
    expect(result.refusal).toContain("unknown schema version");
});

test("a failed fetch falls to the shipped copy with the reason", async () => {
    const result = await loadModelFeed({
        url: "https://example.test/feed.json",
        fetch: () => Promise.reject(new Error("network down")),
    });

    expect(result.source).toBe("shipped");
    expect(result.refusal).toBe("network down");
});

test("a non-200 answer falls to the shipped copy", async () => {
    const result = await loadModelFeed({
        url: "https://example.test/feed.json",
        fetch: () => Promise.resolve(new Response("gone", { status: 404 })),
    });

    expect(result.source).toBe("shipped");
    expect(result.refusal).toBe("feed fetch answered 404");
});

test("no url means the shipped copy answers without a refusal", async () => {
    const result = await loadModelFeed();

    expect(result.source).toBe("shipped");
    expect(result.refusal).toBeUndefined();
    expect(result.feed?.schema_version).toBe(1);
});

test("a missing shipped copy reports no feed at all", async () => {
    const result = await loadModelFeed({
        shippedPath: join(tmpdir(), "vera-feed-absent", "feed.json"),
    });

    expect(result.source).toBe("none");
    expect(result.feed).toBeUndefined();
});

test("the repo's shipped copy parses", () => {
    expect(loadShippedModelFeed()).toBeDefined();
});

test("the repo's shipped copy carries curated rows, not an empty list", () => {
    const shipped = loadShippedModelFeed();

    expect(shipped?.models.length).toBeGreaterThan(0);
    for (const model of shipped?.models ?? []) {
        expect(model.provider.length).toBeGreaterThan(0);
        expect(model.model.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(model.verified_at))).toBe(false);
    }
});

test("the shipped copy stops vouching once it ages past the window", () => {
    const shipped = loadShippedModelFeed();
    const first = shipped?.models.find((model) => model.verdict === "added");
    const stale = new Date(
        Date.parse(first?.verified_at ?? VERIFIED_AT)
        + FEED_FRESHNESS_MS
        + 1_000,
    );

    expect(freshFeedRow(
        shipped as ModelFeed,
        first?.provider ?? "",
        first?.model ?? "",
        stale,
    )).toBeUndefined();
});

test("a null optional field reads as absent rather than dropping the row", () => {
    const parsed = parseModelFeed({
        schema_version: 1,
        generated_at: VERIFIED_AT,
        models: [{
            ...row(),
            provider_default_level: null,
            reason: null,
            response_model: null,
        }],
    });

    expect(parsed?.models).toHaveLength(1);
    expect(parsed?.models[0]?.provider_default_level).toBeUndefined();
    expect(parsed?.models[0]?.response_model).toBeUndefined();
    expect(parsed?.models[0]?.reason).toBeUndefined();
});

test("a malformed row is dropped without costing the rest of the feed", () => {
    const parsed = parseModelFeed({
        schema_version: 1,
        generated_at: VERIFIED_AT,
        models: [row(), { provider: "openrouter", verdict: "added" }],
    });

    expect(parsed?.models).toHaveLength(1);
});

test("a fresh added row answers within the four-day window", () => {
    const now = new Date(Date.parse(VERIFIED_AT) + FEED_FRESHNESS_MS - 1);

    const hit = freshFeedRow(
        feed([row()]),
        "openrouter",
        "qwen/qwen3-coder",
        now,
    );

    expect(hit?.verdict).toBe("added");
});

test("a row past the window stops answering", () => {
    const now = new Date(Date.parse(VERIFIED_AT) + FEED_FRESHNESS_MS + 1);

    expect(freshFeedRow(feed([row()]), "openrouter", "qwen/qwen3-coder", now))
        .toBeUndefined();
});

test("a failure row never vouches, however fresh", () => {
    const failed = row({ verdict: "incompatible", reason: "no such model" });
    const now = new Date(Date.parse(VERIFIED_AT) + 1);

    expect(freshFeedRow(feed([failed]), "openrouter", "qwen/qwen3-coder", now))
        .toBeUndefined();
});

test("a row with an unparseable timestamp never vouches", () => {
    const undated = row({ verified_at: "yesterday-ish" });

    expect(freshFeedRow(feed([undated]), "openrouter", "qwen/qwen3-coder"))
        .toBeUndefined();
});

test("feed facts carry vera as the checker and the row's own timestamp", () => {
    const facts = feedLearnedFacts(row());

    expect(facts["efforts.low"]).toEqual({
        ok: true,
        seen: VERIFIED_AT,
        wire: "low",
        checked: "vera",
    });
    expect(facts["efforts.high"]?.ok).toBe(true);
    expect(facts["probe"]).toEqual({
        ok: true,
        seen: VERIFIED_AT,
        checked: "vera",
        wire: "qwen/qwen3-coder-480b",
    });
    expect(facts["tools"]?.checked).toBe("vera");
});

test("a wire string outside the ladder is dropped, not misfiled", () => {
    const facts = feedLearnedFacts(row({ verified_levels: ["turbo", "high"] }));

    expect(Object.keys(facts).filter((key) => key.startsWith("efforts.")))
        .toEqual(["efforts.high"]);
});

test("an added verdict becomes a row with its verified wire strings", () => {
    const built = feedRowForVerdict({
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        verdict: {
            status: "added",
            learned: {
                "efforts.low": { ok: true, seen: VERIFIED_AT, wire: "low" },
                "efforts.high": { ok: false, seen: VERIFIED_AT, error: "400" },
                probe: { ok: true, seen: VERIFIED_AT, wire: "qwen-routed" },
                tools: { ok: true, seen: VERIFIED_AT },
            },
            droppedLevels: ["high"],
        },
        catalogModel: {
            id: "qwen/qwen3-coder",
            label: "Qwen3 Coder",
            default_level: "medium",
            levels: [],
        },
        verifiedAt: VERIFIED_AT,
    });

    expect(built).toEqual({
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        verdict: "added",
        verified_levels: ["low"],
        provider_default_level: "medium",
        response_model: "qwen-routed",
        verified_at: VERIFIED_AT,
    });
});

test("a failure verdict becomes a row carrying the reason", () => {
    const built = feedRowForVerdict({
        provider: "openrouter",
        model: "missing/model",
        verdict: { status: "incompatible", reason: "no such model" },
        verifiedAt: VERIFIED_AT,
    });

    expect(built.verdict).toBe("incompatible");
    expect(built.reason).toBe("no such model");
    expect(built.verified_levels).toEqual([]);
});

test("a probe row round-trips through the feed parser", () => {
    const built = feedRowForVerdict({
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        verdict: { status: "unavailable", reason: "timed out" },
        verifiedAt: VERIFIED_AT,
    });

    const parsed = parseModelFeed(feed([built]));

    expect(parsed?.models).toEqual([built]);
});
