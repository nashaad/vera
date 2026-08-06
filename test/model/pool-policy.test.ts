import { expect, test } from "bun:test";

import type { CatalogModel } from "../../src/model/catalog-shape.ts";
import { type PoolFile, parsePoolFile } from "../../src/model/pool-file.ts";
import {
    decideSelection,
    lookupModel,
    matchesPattern,
    resolveContext,
    resolveEffort,
    resolveFallback,
    resolveTools,
    supportedEfforts,
} from "../../src/model/pool-policy.ts";

test("deny wins over allow", () => {
    const file = pool({
        defaults: { allow: ["*"], deny: ["openrouter/*:free"] },
    });

    expect(decideSelection("openrouter/kimi-k3:free", file))
        .toEqual({ allowed: false, pattern: "openrouter/*:free", rule: "deny" });
    expect(decideSelection("openrouter/kimi-k3", file).allowed).toBe(true);
});

test("an absent allow list allows everything, an empty one allows nothing", () => {
    expect(decideSelection("openai/gpt-5", pool({})).allowed).toBe(true);
    expect(decideSelection("openai/gpt-5", pool({ defaults: { allow: [] } })).allowed)
        .toBe(false);
});

test("a model outside the allow list is not selectable", () => {
    const file = pool({ defaults: { allow: ["bedrock/*"] } });

    expect(decideSelection("bedrock/claude-sonnet-5", file).allowed).toBe(true);
    expect(decideSelection("openai/gpt-5", file).allowed).toBe(false);
});

test("glob patterns match across the provider separator and single characters", () => {
    expect(matchesPattern("openrouter/kimi-k3:free", "openrouter/*:free"))
        .toBe(true);
    expect(matchesPattern("openrouter/kimi-k3", "openrouter/*:free")).toBe(false);
    expect(matchesPattern("openai/gpt-5", "*")).toBe(true);
    expect(matchesPattern("openai/gpt-5", "openai/gpt-?")).toBe(true);
    expect(matchesPattern("openai/gpt-50", "openai/gpt-?")).toBe(false);
});

test("a dot in a pattern is literal", () => {
    expect(matchesPattern("openai/gpt-5.1", "openai/gpt-5.1")).toBe(true);
    expect(matchesPattern("openai/gpt-501", "openai/gpt-5.1")).toBe(false);
});

test("declared beats learned beats catalog for tools", () => {
    const catalog = catalogOf({ tool_support: false });

    expect(resolveTools(lookupModel("p/m", pool({
        models: { "p/m": { tools: true } },
    }), catalog))).toEqual({ value: true, source: "declared" });

    expect(resolveTools(lookupModel("p/m", pool({
        models: { "p/m": { learned: { tools: { ok: true, seen: "2026-08-06" } } } },
    }), catalog))).toEqual({ value: true, source: "learned" });

    expect(resolveTools(lookupModel("p/m", pool({}), catalog)))
        .toEqual({ value: false, source: "catalog" });
});

test("context falls through to the catalog when nothing is declared", () => {
    const catalog = catalogOf({ context_window: 200000 });

    expect(resolveContext(lookupModel("p/m", pool({}), catalog)))
        .toEqual({ value: 200000, source: "catalog" });
    expect(resolveContext(lookupModel("p/m", pool({
        models: { "p/m": { context: 1000000 } },
    }), catalog))).toEqual({ value: 1000000, source: "declared" });
});

test("a null effort forbids the level, a string is the wire value", () => {
    const lookup = lookupModel("p/m", pool({
        models: { "p/m": { efforts: { off: null, high: "high_effort" } } },
    }));

    expect(resolveEffort("off", lookup))
        .toEqual({ level: "off", status: "forbidden", source: "declared" });
    expect(resolveEffort("high", lookup)).toEqual({
        level: "high",
        status: "supported",
        wire: "high_effort",
        source: "declared",
    });
});

test("a missing effort key with no other evidence means the provider default", () => {
    const lookup = lookupModel("p/m", pool({
        models: { "p/m": { efforts: { high: "high" } } },
    }));

    expect(resolveEffort("low", lookup))
        .toEqual({ level: "low", status: "provider_default" });
});

test("a learned rejection forbids a level nobody declared", () => {
    const lookup = lookupModel("p/m", pool({
        models: {
            "p/m": {
                learned: {
                    "efforts.xhigh": {
                        ok: false,
                        seen: "2026-08-06",
                        error: "unsupported reasoning effort",
                    },
                },
            },
        },
    }), catalogOf({ levels: [{ id: "xhigh", label: "Xhigh" }] }));

    expect(resolveEffort("xhigh", lookup)).toEqual({
        level: "xhigh",
        status: "forbidden",
        source: "learned",
        contradiction: "unsupported reasoning effort",
    });
});

test("a learned rejection never overrules a declared level, it is reported", () => {
    const lookup = lookupModel("p/m", pool({
        models: {
            "p/m": {
                efforts: { xhigh: "xhigh" },
                learned: {
                    "efforts.xhigh": {
                        ok: false,
                        seen: "2026-08-06",
                        error: "unsupported reasoning effort",
                    },
                },
            },
        },
    }));

    expect(resolveEffort("xhigh", lookup)).toEqual({
        level: "xhigh",
        status: "supported",
        wire: "xhigh",
        source: "declared",
        contradiction: "unsupported reasoning effort",
    });
});

test("the catalog supplies levels nothing else mentions", () => {
    const lookup = lookupModel(
        "p/m",
        pool({}),
        catalogOf({ levels: [{ id: "medium", label: "Medium" }] }),
    );

    expect(resolveEffort("medium", lookup)).toEqual({
        level: "medium",
        status: "supported",
        wire: "medium",
        source: "catalog",
    });
});

test("supported efforts list the ladder weakest first", () => {
    const lookup = lookupModel("p/m", pool({
        models: {
            "p/m": { efforts: { high: "high", off: null, low: "low" } },
        },
    }));

    expect(supportedEfforts(lookup).map((resolution) => resolution.level))
        .toEqual(["low", "high"]);
});

test("fallback keeps same-provider targets that selection allows", () => {
    const file = pool({
        defaults: { deny: ["bedrock/claude-haiku-4-5"] },
        models: {
            "bedrock/claude-sonnet-5": {
                fallback: [
                    "bedrock/claude-haiku-4-5",
                    "bedrock/claude-opus-4-6",
                ],
            },
        },
    });

    expect(resolveFallback("bedrock/claude-sonnet-5", file))
        .toEqual(["bedrock/claude-opus-4-6"]);
});

function pool(value: unknown): PoolFile {
    return parsePoolFile(value).file;
}

function catalogOf(
    model: Partial<CatalogModel>,
): ReadonlyMap<string, CatalogModel> {
    return new Map([["p/m", {
        id: "p/m",
        label: "M",
        levels: [],
        ...model,
    }]]);
}
