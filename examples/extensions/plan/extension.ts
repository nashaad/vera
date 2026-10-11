import type { VeraClientExtensionApi, VeraExtensionApi } from "../../../src/sdk/extensions.ts";

const PLAN_INSTRUCTIONS = `Create a plan artifact with artifact_write and use it to sync on the plan
with the user, instead of only chatting about it. The plan lists the steps in
order, the files each one touches, and what would tell you a step went wrong.
Ask about anything the plan depends on that you can't decide yourself.

Do only the steps the user has agreed to. When the work shows the plan is
wrong, update the artifact and check with the user before you go on.`;

const ASKS_FOR_A_PLAN =
    /\b(plan|approach|strategy|how (would|should) (we|i)|before (we|you) start)\b/i;

interface PlanExtensionConfig {
    readonly composeSuggestion: boolean;
    /** Undefined keeps the agent convention: every installed skill. */
    readonly skills?: readonly string[];
}

export function activate(vera: VeraExtensionApi): void {
    const config = planExtensionConfig(vera.config);
    vera.agents.register({
        name: "plan",
        description: "agrees a plan with you, keeps it current, then works through it",
        instructions: PLAN_INSTRUCTIONS,
        ...(config.skills === undefined ? {} : { skills: config.skills }),
    });
}

export function planExtensionConfig(value: unknown): PlanExtensionConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { composeSuggestion: false };
    }
    const raw = value as Record<string, unknown>;
    const skills = Array.isArray(raw.skills)
            && raw.skills.every((skill) =>
                typeof skill === "string" && skill.trim().length > 0
            )
        ? raw.skills.map((skill) => (skill as string).trim())
        : undefined;
    return {
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
