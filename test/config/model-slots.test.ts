import { expect, test } from "bun:test";

import { parseModelCatalogConfig } from "../../src/config/model-catalog.ts";
import {
    JOB_SLOT_INTENTS,
    MODEL_SLOT_IDS,
    MODEL_SLOT_INTENTS,
    bindModelSlot,
    isAutoAssignable,
    slotExclusions,
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

test("an excluded provider is never auto assigned, at any of its models", () => {
    const rules = slotExclusions({}, "extra");
    expect(isAutoAssignable(
        { provider: "cerebras", model: "qwen-3-coder", name: "a" },
        rules,
    )).toBe(false);
    expect(isAutoAssignable(
        { provider: "cerebras", model: "llama-4", name: "b" },
        rules,
    )).toBe(false);
});

test("a provider barred from one slot stays eligible for another", () => {
    const entry = { provider: "cerebras" as const, model: "qwen", name: "a" };
    expect(isAutoAssignable(entry, slotExclusions({}, "extra"))).toBe(false);
    expect(isAutoAssignable(entry, slotExclusions({}, "snappy"))).toBe(true);
});

test("a user rule adds to the shipped default rather than replacing it", () => {
    const slots = parseModelSlotsConfig(
        { never_auto: { snappy: [{ provider: "ollama" }] } },
        ROUTES,
    );
    const rules = slotExclusions(slots ?? {}, "snappy");
    // The user was thinking about ollama, not about fable. Losing the shipped
    // rule because they wrote one of their own is the footgun this avoids.
    expect(isAutoAssignable(
        { provider: "ollama", model: "qwen3", name: "a" },
        rules,
    )).toBe(false);
    expect(isAutoAssignable(
        { provider: "openrouter", model: "anthropic/claude-fable-5", name: "b" },
        rules,
    )).toBe(false);
});

test("an empty user list clears a slot's exclusions", () => {
    const slots = parseModelSlotsConfig({ never_auto: { extra: [] } }, ROUTES);
    expect(slotExclusions(slots ?? {}, "extra")).toEqual([]);
    expect(isAutoAssignable(
        { provider: "cerebras", model: "qwen", name: "a" },
        slotExclusions(slots ?? {}, "extra"),
    )).toBe(true);
});

test("a never_auto rule naming neither provider nor model is refused", () => {
    expect(parseModelSlotsConfig({ never_auto: { extra: [{}] } }, ROUTES))
        .toBeUndefined();
});

test("an exclusion naming a model leaves its neighbours assignable", () => {
    const rules = slotExclusions({}, "extra");
    expect(isAutoAssignable(
        { provider: "openrouter", model: "anthropic/claude-fable-5", name: "a" },
        rules,
    )).toBe(false);
    expect(isAutoAssignable(
        { provider: "openrouter", model: "anthropic/claude-opus-5", name: "b" },
        rules,
    )).toBe(true);
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

test("an unbound job slot draws on the intent behind it", () => {
    const slots = parseModelSlotsConfig(
        { extra: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(catalog(), slots ?? {}, {
        slot: "reviewer",
        demand: "required",
    });
    expect(bound.source).toBe("intent");
    expect(bound.models.map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
});

test("a bound job slot answers for itself and leaves its intent alone", () => {
    const slots = parseModelSlotsConfig(
        { extra: { model_route: "thinking" }, reviewer: { model_route: "quick" } },
        ROUTES,
    );
    const bound = bindModelSlot(catalog(), slots ?? {}, {
        slot: "reviewer",
        demand: "required",
    });
    expect(bound.source).toBe("slot");
    expect(bound.models.map((m) => m.name)).toEqual(["glm_low"]);
    // Pointing the reviewer somewhere must not move everything sharing extra.
    expect(resolveModelSlot(catalog(), slots ?? {}, "extra")?.models
        .map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
});

test("a job slot with neither itself nor its intent bound reaches the session", () => {
    const bound = bindModelSlot(catalog(), {}, {
        slot: "compaction",
        demand: "required",
    });
    expect(bound.source).toBe("session");
});

test("every job slot names an intent that exists, and every slot an intent line", () => {
    const ids: string[] = [...MODEL_SLOT_IDS];
    for (const [job, intent] of Object.entries(JOB_SLOT_INTENTS)) {
        expect(ids).toContain(intent);
        expect(ids).toContain(job);
    }
    for (const slot of MODEL_SLOT_IDS) {
        expect(MODEL_SLOT_INTENTS[slot].length).toBeGreaterThan(0);
    }
});

function reachableExcept(...unreachable: string[]) {
    return (entry: { name: string }) => !unreachable.includes(entry.name);
}

test("a route falls to its own next entry before any rung is climbed", () => {
    const slots = parseModelSlotsConfig(
        { extra: { model_route: "quick" }, reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(
        catalog(),
        slots ?? {},
        { slot: "reviewer", demand: "required" },
        reachableExcept("opus_low"),
    );
    // The user asked for opus then glm. Losing opus must not hand the job to
    // extra while a model they named is still standing.
    expect(bound.source).toBe("slot");
    expect(bound.models.map((m) => m.name)).toEqual(["glm_high"]);
});

test("a binding reports what was named as well as what will run", () => {
    const slots = parseModelSlotsConfig(
        { reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(
        catalog(),
        slots ?? {},
        { slot: "reviewer", demand: "required" },
        reachableExcept("opus_low"),
    );
    expect(bound.declared.map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
    expect(bound.models.map((m) => m.name)).toEqual(["glm_high"]);
});

test("a route with nothing reachable climbs to the intent slot", () => {
    const slots = parseModelSlotsConfig(
        { extra: { model_route: "quick" }, reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(
        catalog(),
        slots ?? {},
        { slot: "reviewer", demand: "required" },
        reachableExcept("opus_low", "glm_high"),
    );
    expect(bound.source).toBe("intent");
    expect(bound.models.map((m) => m.name)).toEqual(["glm_low"]);
});

test("a required caller with nothing reachable anywhere uses the session", () => {
    const slots = parseModelSlotsConfig(
        { reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(
        catalog(),
        slots ?? {},
        { slot: "reviewer", demand: "required" },
        () => false,
    );
    expect(bound.source).toBe("session");
});

test("an unasked reachability check leaves every declared entry standing", () => {
    const slots = parseModelSlotsConfig(
        { reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelSlot(catalog(), slots ?? {}, {
        slot: "reviewer",
        demand: "required",
    });
    expect(bound.models).toEqual(bound.declared);
    expect(bound.models).toHaveLength(2);
});
