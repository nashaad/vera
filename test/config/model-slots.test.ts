import { expect, test } from "bun:test";

import { parseModelCatalogConfig } from "../../src/config/model-catalog.ts";
import {
    bindModelSlot,
    isAutoAssignable,
    parseModelSlotsConfig,
    resolveModelSlot,
    slotLabel,
} from "../../src/config/model-slots.ts";

const MODELS = [
    { provider: "openrouter", model: "z-ai/glm-5.2", name: "glm_low",
        reasoning_effort: "low" },
    { provider: "openrouter", model: "z-ai/glm-5.2", name: "glm_high",
        reasoning_effort: "high" },
    { provider: "openrouter", model: "anthropic/claude-opus-5",
        name: "opus_low", reasoning_effort: "low" },
];

const ROUTES = {
    quick: ["glm_low"],
    thinking: ["opus_low", "glm_high"],
};

function catalog() {
    const parsed = parseModelCatalogConfig(MODELS, ROUTES, {});
    if (parsed === undefined) throw new Error("catalog did not parse");
    return parsed;
}

test("a slot resolves to the route's entries, each with its own effort", () => {
    const slots = parseModelSlotsConfig(
        { eco: { model_route: "thinking" } },
        ROUTES,
    );
    const resolved = resolveModelSlot(catalog(), slots ?? {}, "eco");
    expect(resolved?.models.map((m) => m.name))
        .toEqual(["opus_low", "glm_high"]);
    // The same model at two efforts is two different answers, which is the
    // thing a slot can say and a bare model name cannot.
    expect(resolved?.models[0]?.reasoning_effort).toBe("low");
    expect(resolved?.models[1]?.reasoning_effort).toBe("high");
});

test("an unbound slot resolves to nothing, so its callers do not run", () => {
    const slots = parseModelSlotsConfig(
        { snappy: { model_route: "quick" } },
        ROUTES,
    );
    expect(resolveModelSlot(catalog(), slots ?? {}, "snappy")).toBeDefined();
    expect(resolveModelSlot(catalog(), slots ?? {}, "eco")).toBeUndefined();
    expect(resolveModelSlot(catalog(), slots ?? {}, "extra")).toBeUndefined();
});

test("renaming a label leaves the id callers bind to untouched", () => {
    const slots = parseModelSlotsConfig(
        { snappy: { model_route: "quick", label: "turbo" } },
        ROUTES,
    );
    expect(slotLabel(slots ?? {}, "snappy")).toBe("turbo");
    expect(slotLabel(slots ?? {}, "eco")).toBe("eco");
    const resolved = resolveModelSlot(catalog(), slots ?? {}, "snappy");
    expect(resolved?.slot).toBe("snappy");
    expect(resolved?.label).toBe("turbo");
    expect(resolved?.models.map((m) => m.name)).toEqual(["glm_low"]);
});

test("an unknown slot id is rejected rather than ignored", () => {
    expect(parseModelSlotsConfig({ zippy: { model_route: "quick" } }, ROUTES))
        .toBeUndefined();
});

test("a slot naming an unknown route is rejected", () => {
    expect(parseModelSlotsConfig({ eco: { model_route: "nope" } }, ROUTES))
        .toBeUndefined();
});

test("an absent block is an empty set of slots, not a failure", () => {
    expect(parseModelSlotsConfig(undefined, ROUTES)).toEqual({});
});

test("a blank label falls back to the shipped word", () => {
    const slots = parseModelSlotsConfig(
        { extra: { model_route: "thinking", label: "  " } },
        ROUTES,
    );
    expect(slots).toBeUndefined();
});

test("a route the feature names itself outranks the slot", () => {
    const slots = parseModelSlotsConfig(
        { eco: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(catalog(), slots ?? {}, {
        slot: "eco",
        demand: "required",
        explicitRoute: "quick",
    });
    expect(bound.source).toBe("explicit");
    expect(bound.models.map((m) => m.name)).toEqual(["glm_low"]);
});

test("a feature with no route of its own falls to the slot", () => {
    const slots = parseModelSlotsConfig(
        { eco: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(catalog(), slots ?? {}, {
        slot: "eco",
        demand: "required",
    });
    expect(bound.source).toBe("slot");
    expect(bound.models.map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
});

test("a required caller with nothing bound runs on the session's model", () => {
    const bound = bindModelSlot(catalog(), {}, {
        slot: "eco",
        demand: "required",
    });
    expect(bound.source).toBe("session");
    expect(bound.models).toEqual([]);
});

test("an optional caller with nothing bound does not run", () => {
    const bound = bindModelSlot(catalog(), {}, {
        slot: "snappy",
        demand: "optional",
    });
    expect(bound.source).toBe("none");
    expect(bound.models).toEqual([]);
});

test("an unresolvable explicit route falls through rather than failing", () => {
    const slots = parseModelSlotsConfig(
        { eco: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(catalog(), slots ?? {}, {
        slot: "eco",
        demand: "required",
        explicitRoute: "gone",
    });
    expect(bound.source).toBe("slot");
});

test("an excluded provider is never auto assigned, at any of its models", () => {
    expect(isAutoAssignable({
        provider: "cerebras", model: "qwen-3-coder", name: "a",
    })).toBe(false);
    expect(isAutoAssignable({
        provider: "cerebras", model: "llama-4", name: "b",
    })).toBe(false);
});

test("an exclusion naming a model leaves the provider's others assignable", () => {
    expect(isAutoAssignable({
        provider: "anthropic", model: "claude-fable-5", name: "a",
    })).toBe(false);
    expect(isAutoAssignable({
        provider: "anthropic", model: "claude-opus-5", name: "b",
    })).toBe(true);
});

test("exclusions bind automatic assignment, not what the user binds", () => {
    const routes = { fast: ["cerebras_qwen"] };
    const parsed = parseModelCatalogConfig(
        [{ provider: "cerebras", model: "qwen-3-coder", name: "cerebras_qwen" }],
        routes,
        {},
    );
    if (parsed === undefined) throw new Error("catalog did not parse");
    const slots = parseModelSlotsConfig({ snappy: { model_route: "fast" } }, routes);
    const resolved = resolveModelSlot(parsed, slots ?? {}, "snappy");
    expect(resolved?.models.map((m) => m.name)).toEqual(["cerebras_qwen"]);
});
