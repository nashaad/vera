import type { VeraClientExtensionApi, VeraExtensionApi } from "../../src/sdk/extensions.ts";

const PLAN_INSTRUCTIONS = `You are planning, not building.

Read whatever you need. Do not write files, do not run commands that change
anything, and do not start the work. Produce a plan: the steps in order, the
files each one touches, and what would tell you a step went wrong.

When the plan is ready, say so and stop. The user decides whether to run it.`;

const ASKS_FOR_A_PLAN =
    /\b(plan|approach|strategy|how (would|should) (we|i)|before (we|you) start)\b/i;

interface PlanExtensionConfig {
    readonly allowSkillScripts: boolean;
    readonly composeSuggestion: boolean;
    /** Undefined keeps the agent convention: every installed skill. */
    readonly skills?: readonly string[];
}

export function activate(vera: VeraExtensionApi): void {
    const config = planExtensionConfig(vera.config);
    vera.agents.register({
        name: "plan",
        description: "reads and plans, never writes",
        instructions: PLAN_INSTRUCTIONS,
        tools: [
            "read",
            "grep",
            "list",
            ...(config.allowSkillScripts ? ["skill_script"] : []),
        ],
        ...(config.skills === undefined ? {} : { skills: config.skills }),
        posture: "readonly",
        forbiddenAccess: ["auto", "full_access"],
        nudges: [{
            on: "*",
            text:
                "The plan agent is read-only on purpose. Finish the plan, then"
                + " /agent default to carry it out.",
        }],
    });
}

export function planExtensionConfig(value: unknown): PlanExtensionConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { allowSkillScripts: false, composeSuggestion: false };
    }
    const raw = value as Record<string, unknown>;
    const skills = Array.isArray(raw.skills)
            && raw.skills.every((skill) =>
                typeof skill === "string" && skill.trim().length > 0
            )
        ? raw.skills.map((skill) => (skill as string).trim())
        : undefined;
    return {
        allowSkillScripts: raw.allow_skill_scripts === true,
        composeSuggestion: raw.compose_suggestion === true,
        ...(skills === undefined ? {} : { skills }),
    };
}

export function activateClient(vera: VeraClientExtensionApi): void {
    if (!planExtensionConfig(vera.config).composeSuggestion) return;
    vera.compose.registerSuggester({
        agent: "plan",
        hint: "Create a plan?",
        match(text: string) {
            return ASKS_FOR_A_PLAN.test(text);
        },
    });
}
