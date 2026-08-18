// Plan mode, shipped the way Codex ships it: as an agent you can wear, plus a
// compose-time offer to wear it. No mode, no toggle, no core intent-guessing.
//
// Core never reads what you are typing. This extension does, and it only does
// so because you installed it — installing it is the consent. Accepting the
// offer goes through the ordinary wear path, which is loud, queued, and
// recorded like any other wear.

const PLAN_INSTRUCTIONS = `You are planning, not building.

Read whatever you need. Do not write files, do not run commands that change
anything, and do not start the work. Produce a plan: the steps in order, the
files each one touches, and what would tell you a step went wrong.

When the plan is ready, say so and stop. The user decides whether to run it.`;

/** The words people actually type when they want a plan before the work. */
const ASKS_FOR_A_PLAN =
    /\b(plan|approach|strategy|how (would|should) (we|i)|before (we|you) start)\b/i;

interface PlanExtensionConfig {
    readonly allowSkillScripts: boolean;
    /** Undefined keeps the agent convention: every installed skill. */
    readonly skills?: readonly string[];
}

export function activate(vera: any): void {
    const config = planExtensionConfig(vera.config);
    vera.agents.register({
        name: "plan",
        description: "reads and plans, never writes",
        instructions: PLAN_INSTRUCTIONS,
        tools: [
            "read",
            "grep",
            "ls",
            "glob",
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
        return { allowSkillScripts: true };
    }
    const raw = value as Record<string, unknown>;
    const skills = Array.isArray(raw.skills)
            && raw.skills.every((skill) =>
                typeof skill === "string" && skill.trim().length > 0
            )
        ? raw.skills.map((skill) => (skill as string).trim())
        : undefined;
    return {
        allowSkillScripts: raw.allow_skill_scripts !== false,
        ...(skills === undefined ? {} : { skills }),
    };
}

export function activateClient(vera: any): void {
    vera.compose.registerSuggester({
        agent: "plan",
        hint: "Create a plan?",
        match(text: string) {
            return ASKS_FOR_A_PLAN.test(text);
        },
    });
}
