import { expect, test } from "bun:test";

import { parseModelCatalogConfig } from "../../src/config/model-catalog.ts";
import {
    JOB_ASSIGNMENT_INTENTS,
    MODEL_ASSIGNMENT_IDS,
    MODEL_ASSIGNMENT_INTENTS,
    bindModelAssignment,
    isAutoAssignable,
    slotExclusions,
    parseModelAssignmentsConfig,
    resolveModelAssignment,
    assignmentLabel,
} from "../../src/config/model-assignments.ts";

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

test("a assignment resolves to the route's entries, each with its own effort", () => {
    const assignments = parseModelAssignmentsConfig(
        { eco: { model_route: "thinking" } },
        ROUTES,
    );
    const resolved = resolveModelAssignment(catalog(), assignments ?? {}, "eco");
    expect(resolved?.models.map((m) => m.name))
        .toEqual(["opus_low", "glm_high"]);
    // The same model at two efforts is two different answers, which is the
    // thing a assignment can say and a bare model name cannot.
    expect(resolved?.models[0]?.reasoning_effort).toBe("low");
    expect(resolved?.models[1]?.reasoning_effort).toBe("high");
});

test("an unbound assignment resolves to nothing, so its callers do not run", () => {
    const assignments = parseModelAssignmentsConfig(
        { snappy: { model_route: "quick" } },
        ROUTES,
    );
    expect(resolveModelAssignment(catalog(), assignments ?? {}, "snappy")).toBeDefined();
    expect(resolveModelAssignment(catalog(), assignments ?? {}, "eco")).toBeUndefined();
    expect(resolveModelAssignment(catalog(), assignments ?? {}, "extra")).toBeUndefined();
});

test("renaming a label leaves the id callers bind to untouched", () => {
    const assignments = parseModelAssignmentsConfig(
        { snappy: { model_route: "quick", label: "turbo" } },
        ROUTES,
    );
    expect(assignmentLabel(assignments ?? {}, "snappy")).toBe("turbo");
    expect(assignmentLabel(assignments ?? {}, "eco")).toBe("eco");
    const resolved = resolveModelAssignment(catalog(), assignments ?? {}, "snappy");
    expect(resolved?.assignment).toBe("snappy");
    expect(resolved?.label).toBe("turbo");
    expect(resolved?.models.map((m) => m.name)).toEqual(["glm_low"]);
});

test("an unknown assignment id is rejected rather than ignored", () => {
    expect(parseModelAssignmentsConfig({ zippy: { model_route: "quick" } }, ROUTES))
        .toBeUndefined();
});

test("a assignment naming an unknown route is rejected", () => {
    expect(parseModelAssignmentsConfig({ eco: { model_route: "nope" } }, ROUTES))
        .toBeUndefined();
});

test("an absent block is an empty set of assignments, not a failure", () => {
    expect(parseModelAssignmentsConfig(undefined, ROUTES)).toEqual({});
});

test("a blank label falls back to the shipped word", () => {
    const assignments = parseModelAssignmentsConfig(
        { extra: { model_route: "thinking", label: "  " } },
        ROUTES,
    );
    expect(assignments).toBeUndefined();
});

test("a feature with no route of its own falls to the assignment", () => {
    const assignments = parseModelAssignmentsConfig(
        { eco: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelAssignment(catalog(), assignments ?? {}, {
        assignment: "eco",
    });
    expect(bound.source).toBe("assignment");
    expect(bound.models.map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
});

test("a required caller with nothing bound runs on the session's model", () => {
    const bound = bindModelAssignment(catalog(), {}, {
        assignment: "eco",
    });
    expect(bound.source).toBe("session");
    expect(bound.models).toEqual([]);
});

test("nothing bound anywhere still runs, on the session's own model", () => {
    const bound = bindModelAssignment(catalog(), {}, { assignment: "snappy" });
    expect(bound.source).toBe("session");
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

test("a provider barred from one assignment stays eligible for another", () => {
    const entry = { provider: "cerebras" as const, model: "qwen", name: "a" };
    expect(isAutoAssignable(entry, slotExclusions({}, "extra"))).toBe(false);
    expect(isAutoAssignable(entry, slotExclusions({}, "snappy"))).toBe(true);
});

test("a user rule adds to the shipped default rather than replacing it", () => {
    const assignments = parseModelAssignmentsConfig(
        { never_auto: { snappy: [{ provider: "ollama" }] } },
        ROUTES,
    );
    const rules = slotExclusions(assignments ?? {}, "snappy");
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

test("an empty user list clears a assignment's exclusions", () => {
    const assignments = parseModelAssignmentsConfig({ never_auto: { extra: [] } }, ROUTES);
    expect(slotExclusions(assignments ?? {}, "extra")).toEqual([]);
    expect(isAutoAssignable(
        { provider: "cerebras", model: "qwen", name: "a" },
        slotExclusions(assignments ?? {}, "extra"),
    )).toBe(true);
});

test("a never_auto rule naming neither provider nor model is refused", () => {
    expect(parseModelAssignmentsConfig({ never_auto: { extra: [{}] } }, ROUTES))
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
    const assignments = parseModelAssignmentsConfig({ snappy: { model_route: "fast" } }, routes);
    const resolved = resolveModelAssignment(parsed, assignments ?? {}, "snappy");
    expect(resolved?.models.map((m) => m.name)).toEqual(["cerebras_qwen"]);
});

test("an unbound job assignment draws on the intent behind it", () => {
    const assignments = parseModelAssignmentsConfig(
        { extra: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelAssignment(catalog(), assignments ?? {}, {
        assignment: "reviewer",
    });
    expect(bound.source).toBe("intent");
    expect(bound.models.map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
});

test("a bound job assignment answers for itself and leaves its intent alone", () => {
    const assignments = parseModelAssignmentsConfig(
        { extra: { model_route: "thinking" }, reviewer: { model_route: "quick" } },
        ROUTES,
    );
    const bound = bindModelAssignment(catalog(), assignments ?? {}, {
        assignment: "reviewer",
    });
    expect(bound.source).toBe("assignment");
    expect(bound.models.map((m) => m.name)).toEqual(["glm_low"]);
    // Pointing the reviewer somewhere must not move everything sharing extra.
    expect(resolveModelAssignment(catalog(), assignments ?? {}, "extra")?.models
        .map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
});

test("a job assignment with neither itself nor its intent bound reaches the session", () => {
    const bound = bindModelAssignment(catalog(), {}, {
        assignment: "compaction",
    });
    expect(bound.source).toBe("session");
});

test("every job assignment names an intent that exists, and every assignment an intent line", () => {
    const ids: string[] = [...MODEL_ASSIGNMENT_IDS];
    for (const [job, intent] of Object.entries(JOB_ASSIGNMENT_INTENTS)) {
        expect(ids).toContain(intent);
        expect(ids).toContain(job);
    }
    for (const assignment of MODEL_ASSIGNMENT_IDS) {
        expect(MODEL_ASSIGNMENT_INTENTS[assignment].length).toBeGreaterThan(0);
    }
});

function reachableExcept(...unreachable: string[]) {
    return (entry: { name: string }) => !unreachable.includes(entry.name);
}

test("a route falls to its own next entry before any rung is climbed", () => {
    const assignments = parseModelAssignmentsConfig(
        { extra: { model_route: "quick" }, reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelAssignment(
        catalog(),
        assignments ?? {},
        { assignment: "reviewer" },
        reachableExcept("opus_low"),
    );
    // The user asked for opus then glm. Losing opus must not hand the job to
    // extra while a model they named is still standing.
    expect(bound.source).toBe("assignment");
    expect(bound.models.map((m) => m.name)).toEqual(["glm_high"]);
});

test("a binding reports what was named as well as what will run", () => {
    const assignments = parseModelAssignmentsConfig(
        { reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelAssignment(
        catalog(),
        assignments ?? {},
        { assignment: "reviewer" },
        reachableExcept("opus_low"),
    );
    expect(bound.declared.map((m) => m.name)).toEqual(["opus_low", "glm_high"]);
    expect(bound.models.map((m) => m.name)).toEqual(["glm_high"]);
});

test("a route with nothing reachable climbs to the intent assignment", () => {
    const assignments = parseModelAssignmentsConfig(
        { extra: { model_route: "quick" }, reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelAssignment(
        catalog(),
        assignments ?? {},
        { assignment: "reviewer" },
        reachableExcept("opus_low", "glm_high"),
    );
    expect(bound.source).toBe("intent");
    expect(bound.models.map((m) => m.name)).toEqual(["glm_low"]);
});

test("a required caller with nothing reachable anywhere uses the session", () => {
    const assignments = parseModelAssignmentsConfig(
        { reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelAssignment(
        catalog(),
        assignments ?? {},
        { assignment: "reviewer" },
        () => false,
    );
    expect(bound.source).toBe("session");
});

test("an unasked reachability check leaves every declared entry standing", () => {
    const assignments = parseModelAssignmentsConfig(
        { reviewer: { model_route: "thinking" } },
        ROUTES,
    );
    const bound = bindModelAssignment(catalog(), assignments ?? {}, {
        assignment: "reviewer",
    });
    expect(bound.models).toEqual(bound.declared);
    expect(bound.models).toHaveLength(2);
});
