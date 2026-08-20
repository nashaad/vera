import { expect, test } from "bun:test";

import { activate, activateClient, planExtensionConfig } from "./extension.ts";

test("plan skill scripts are enabled by default and skills remain configurable", () => {
    expect(planExtensionConfig(undefined)).toEqual({
        allowSkillScripts: true,
        composeSuggestion: true,
    });
    expect(planExtensionConfig({
        allow_skill_scripts: true,
        skills: [" search-sessions "],
    })).toEqual({
        allowSkillScripts: true,
        composeSuggestion: true,
        skills: ["search-sessions"],
    });
    expect(planExtensionConfig({ allow_skill_scripts: false }))
        .toEqual({ allowSkillScripts: false, composeSuggestion: true });

    let registered: Record<string, unknown> | undefined;
    activate({
        config: {
            skills: ["search-sessions"],
        },
        agents: {
            register(spec: Record<string, unknown>) {
                registered = spec;
            },
        },
    });
    expect(registered).toMatchObject({
        skills: ["search-sessions"],
        tools: ["read", "grep", "ls", "glob", "skill_script"],
    });
});

test("plan's built-in compose offer can be disabled", () => {
    let registrations = 0;
    activateClient({
        config: { compose_suggestion: false },
        compose: {
            registerSuggester() {
                registrations += 1;
            },
        },
    });

    expect(registrations).toBe(0);
});
