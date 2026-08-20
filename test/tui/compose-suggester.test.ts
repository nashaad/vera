import { expect, test } from "bun:test";

import { findActiveComposeSuggester } from "../../clients/tui/compose-suggester.ts";
import type {
    ClientExtensionComposeSuggesterDescriptor,
} from "../../src/extensions/client-registry.ts";

function suggester(
    overrides: Partial<ClientExtensionComposeSuggesterDescriptor> = {},
): ClientExtensionComposeSuggesterDescriptor {
    return {
        id: "plan",
        agent: "plan",
        hint: "Create a plan?",
        source: "example.suggestions",
        matches: (text) => text.includes("plan"),
        ...overrides,
    };
}

test("a compose offer can be limited to named current agents", () => {
    const offer = suggester({ fromAgents: ["default"] });

    expect(findActiveComposeSuggester(
        [offer],
        "plan the fix",
        "default",
        new Set(),
    )).toBe(offer);
    expect(findActiveComposeSuggester(
        [offer],
        "plan the review",
        "reviewer",
        new Set(),
    )).toBeUndefined();
});

test("dismissing one rule does not suppress a sibling for the same agent", () => {
    const first = suggester({
        id: "plan-word",
        matches: (text) => text.includes("plan"),
    });
    const second = suggester({
        id: "strategy-word",
        matches: (text) => text.includes("strategy"),
    });

    expect(findActiveComposeSuggester(
        [first, second],
        "choose a strategy",
        "default",
        new Set(["example.suggestions:plan-word"]),
    )).toBe(second);
});

test("an unscoped compose offer remains eligible for every current agent", () => {
    const offer = suggester();

    expect(findActiveComposeSuggester(
        [offer],
        "plan the review",
        "reviewer",
        new Set(),
    )).toBe(offer);
});

test("compose offers stay hidden for their target, commands, and dismissals", () => {
    const offer = suggester();

    expect(findActiveComposeSuggester(
        [offer],
        "plan this",
        "plan",
        new Set(),
    )).toBeUndefined();
    expect(findActiveComposeSuggester(
        [offer],
        "/plan",
        "default",
        new Set(),
    )).toBeUndefined();
    expect(findActiveComposeSuggester(
        [offer],
        "plan this",
        "default",
        new Set(["example.suggestions:plan"]),
    )).toBeUndefined();
});
