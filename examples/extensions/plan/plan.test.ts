import { expect, test } from "bun:test";

import { activate, activateClient, planExtensionConfig } from "./extension.ts";

test("Plan options require explicit opt-in and preserve the skill allow-list", () => {
    expect(planExtensionConfig(undefined)).toEqual({
        allowSkillScripts: false, composeSuggestion: false,
    });
    expect(planExtensionConfig({ skills: [" search-sessions "] })).toEqual({
        allowSkillScripts: false, composeSuggestion: false,
        skills: ["search-sessions"],
    });
    expect(planExtensionConfig({
        allow_skill_scripts: "true", compose_suggestion: 1, skills: [],
    })).toEqual({ allowSkillScripts: false, composeSuggestion: false, skills: [] });
});

test("Plan options reach the agent and the composer suggestion", () => {
    const agents: { name: string; tools: readonly string[] }[] = [];
    const suggesters: { match(text: string): boolean }[] = [];
    const config = { allow_skill_scripts: true, compose_suggestion: true };

    activate({ config, agents: { register: (agent: never) => agents.push(agent) } } as never);
    activateClient({ config, compose: { registerSuggester: (entry: never) => suggesters.push(entry) } } as never);

    expect(agents).toMatchObject([{ name: "plan", tools: ["read", "grep", "list", "skill_script"] }]);
    expect(suggesters).toHaveLength(1);
    expect(suggesters[0]?.match("make a plan")).toBe(true);
});
