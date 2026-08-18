import { expect, test } from "bun:test";

import { activate, planExtensionConfig } from "./extension.ts";

test("plan skill scripts are explicit and skills remain configurable", () => {
    expect(planExtensionConfig(undefined)).toEqual({
        allowSkillScripts: false,
    });
    expect(planExtensionConfig({
        allow_skill_scripts: true,
        skills: [" search-sessions "],
    })).toEqual({
        allowSkillScripts: true,
        skills: ["search-sessions"],
    });

    let registered: Record<string, unknown> | undefined;
    activate({
        config: {
            allow_skill_scripts: true,
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
