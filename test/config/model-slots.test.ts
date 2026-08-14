import { expect, test } from "bun:test";

import { parseModelCatalogConfig } from "../../src/config/model-catalog.ts";
import {
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
