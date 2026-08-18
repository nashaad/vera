import { expect, test } from "bun:test";

import { activate, planExtensionConfig } from "./extension.ts";

test("plan skill scripts are enabled by default and skills remain configurable", () => {
    expect(planExtensionConfig(undefined)).toEqual({
        allowSkillScripts: true,
    });
    expect(planExtensionConfig({
        allow_skill_scripts: true,
        skills: [" search-sessions "],
    })).toEqual({
        allowSkillScripts: true,
        skills: ["search-sessions"],
    });
    expect(planExtensionConfig({ allow_skill_scripts: false }))
        .toEqual({ allowSkillScripts: false });

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
