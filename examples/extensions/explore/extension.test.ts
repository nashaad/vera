import { expect, test } from "bun:test";

import {
    activate,
    activateClient,
    exploreExtensionConfig,
} from "./extension.ts";

test("explore is read-only and keeps skill access configurable", () => {
    expect(exploreExtensionConfig(undefined)).toEqual({
        allowSkillScripts: true,
        composeSuggestion: true,
    });
    expect(exploreExtensionConfig({
        allow_skill_scripts: true,
        skills: [" search-sessions "],
    })).toEqual({
        allowSkillScripts: true,
        composeSuggestion: true,
        skills: ["search-sessions"],
    });
    expect(exploreExtensionConfig({ allow_skill_scripts: false }))
        .toEqual({ allowSkillScripts: false, composeSuggestion: true });

    let registered: Record<string, unknown> | undefined;
    activate({
        config: { skills: ["search-sessions"] },
        agents: {
            register(spec: Record<string, unknown>) {
                registered = spec;
            },
        },
    });
    expect(registered).toMatchObject({
        name: "explore",
        posture: "readonly",
        forbiddenAccess: ["auto", "full_access"],
        skills: ["search-sessions"],
        tools: ["read", "grep", "ls", "glob", "skill_script"],
    });
});

test("explore offers itself only for investigation-shaped prompts", () => {
    let suggester: {
        readonly agent: string;
        readonly hint: string;
        readonly match: (text: string) => boolean;
    } | undefined;
    activateClient({
        compose: {
            registerSuggester(value: typeof suggester) {
                suggester = value;
            },
        },
    });

    expect(suggester?.agent).toBe("explore");
    expect(suggester?.match("investigate why this request retries")).toBe(true);
    expect(suggester?.match("implement the retry fix")).toBe(false);
});

test("explore's built-in compose offer can be disabled", () => {
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
