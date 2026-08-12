import { expect, test } from "bun:test";

import { reduceModels } from "../../src/model/catalog-reduction.ts";
import { versionChain } from "../../src/model/model-version-chain.ts";

const NOW = 1_760_000_000;
const DAY = 24 * 60 * 60;

/** Every id here is in one family unless a test says otherwise. */
function families(...ids: readonly string[]): ReadonlyMap<string, string> {
    return new Map(ids.map((id) => [id, "one-line"]));
}

function collapse(
    models: readonly { id: string; created?: number }[],
    map = families(...models.map((model) => model.id)),
) {
    return reduceModels(models, {
        now: NOW,
        maxAgeMonths: 0,
        collapseVersions: true,
        families: map,
    });
}

test("a later version replaces the one before it", () => {
    const hidden = collapse([
        { id: "anthropic/claude-opus-4.8", created: NOW - 90 * DAY },
        { id: "anthropic/claude-opus-5", created: NOW - 10 * DAY },
    ]);
    expect(hidden.get("anthropic/claude-opus-4.8")).toBe("superseded");
    expect(hidden.has("anthropic/claude-opus-5")).toBe(false);
});

test("a variant is its own chain, so the plain row is never folded away", () => {
    const hidden = collapse([
        { id: "anthropic/claude-opus-5", created: NOW - 10 * DAY },
        { id: "anthropic/claude-opus-5-fast", created: NOW - 10 * DAY },
        { id: "anthropic/claude-opus-4.8-fast", created: NOW - 90 * DAY },
    ]);
    expect(hidden.has("anthropic/claude-opus-5")).toBe(false);
    expect(hidden.has("anthropic/claude-opus-5-fast")).toBe(false);
    expect(hidden.get("anthropic/claude-opus-4.8-fast")).toBe("superseded");
});

// x.AI listed grok-4.20 four months before grok-4.6. Ordering on the digits
// would read 20 as above 6 and fold the newer model away.
test("the chain is ordered by listing date, not by version number", () => {
    const hidden = collapse([
        { id: "x-ai/grok-4.20", created: NOW - 130 * DAY },
        { id: "x-ai/grok-4.6", created: NOW - 30 * DAY },
    ]);
    expect(hidden.get("x-ai/grok-4.20")).toBe("superseded");
    expect(hidden.has("x-ai/grok-4.6")).toBe(false);
});

test("models that differ by size or job are not a chain", () => {
    const hidden = collapse([
        { id: "qwen/qwen3-coder-30b-a3b-instruct", created: NOW - 40 * DAY },
        { id: "qwen/qwen3-32b", created: NOW - 40 * DAY },
        { id: "qwen/qwen3.8-max", created: NOW - 5 * DAY },
    ]);
    expect(hidden.size).toBe(0);
});

test("a chain models.dev splits across families is left alone", () => {
    const models = [
        { id: "inclusionai/ling-2.6-flash", created: NOW - 90 * DAY },
        { id: "inclusionai/ling-3.0-flash", created: NOW - 10 * DAY },
    ];
    const split = new Map([
        ["inclusionai/ling-2.6-flash", "ling"],
        ["inclusionai/ling-3.0-flash", "inkling"],
    ]);
    expect(collapse(models, split).size).toBe(0);
    expect(collapse(models).size).toBe(1);
});

test("an id models.dev does not cover is not folded", () => {
    const hidden = collapse([
        { id: "vendor/model-1", created: NOW - 90 * DAY },
        { id: "vendor/model-2", created: NOW - 10 * DAY },
    ], families("vendor/model-2"));
    expect(hidden.size).toBe(0);
});

test("an undated model neither replaces nor is replaced", () => {
    const hidden = collapse([
        { id: "vendor/model-1" },
        { id: "vendor/model-2", created: NOW - 10 * DAY },
    ]);
    expect(hidden.size).toBe(0);
});

test("a pooled or curated row wins its chain rather than folding it", () => {
    const hidden = reduceModels([
        { id: "anthropic/claude-opus-4.8", created: NOW - 90 * DAY },
        { id: "anthropic/claude-opus-5", created: NOW - 10 * DAY },
    ], {
        now: NOW,
        maxAgeMonths: 0,
        collapseVersions: true,
        families: families(
            "anthropic/claude-opus-4.8",
            "anthropic/claude-opus-5",
        ),
        keep: new Set(["anthropic/claude-opus-4.8"]),
    });
    expect(hidden.size).toBe(0);
});

test("collapse does nothing at all unless it is asked for", () => {
    const hidden = reduceModels([
        { id: "anthropic/claude-opus-4.8", created: NOW - 90 * DAY },
        { id: "anthropic/claude-opus-5", created: NOW - 10 * DAY },
    ], { now: NOW, maxAgeMonths: 0 });
    expect(hidden.size).toBe(0);
});

test("an id with no version belongs to no chain", () => {
    expect(versionChain("openai/gpt-audio")).toBeUndefined();
    expect(versionChain("z-ai/glm-5.2")?.stem).toBe("z-ai/glm-#");
});
