import { expect, test } from "bun:test";

import { activate, activateClient, planExtensionConfig } from "./extension.ts";

test("Plan options require explicit opt-in and preserve the skill allow-list", () => {
    expect(planExtensionConfig(undefined)).toEqual({ composeSuggestion: false });
    expect(planExtensionConfig({ skills: [" search-sessions "] })).toEqual({
        composeSuggestion: false,
        skills: ["search-sessions"],
    });
    expect(planExtensionConfig({ compose_suggestion: 1, skills: [] }))
        .toEqual({ composeSuggestion: false, skills: [] });
});

test("Plan options reach the agent and the composer suggestion", () => {
    const agents: { name: string; tools?: readonly string[]; nudges?: unknown }[] = [];
    const suggesters: { match(text: string): boolean }[] = [];
    const config = { compose_suggestion: true, skills: ["search-sessions"] };

    activate({ config, agents: { register: (agent: never) => agents.push(agent) } } as never);
    activateClient({ config, compose: { registerSuggester: (entry: never) => suggesters.push(entry) } } as never);

    // No tool list: Plan gets every available tool, and the session mode decides what asks.
    expect(agents).toMatchObject([{ name: "plan", skills: ["search-sessions"] }]);
    expect(agents[0]?.tools).toBeUndefined();
    expect(agents[0]?.nudges).toBeUndefined();
    expect(suggesters).toHaveLength(1);
    expect(suggesters[0]?.match("make a plan")).toBe(true);
});
