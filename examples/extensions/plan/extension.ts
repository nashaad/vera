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

export function activate(vera: any): void {
    vera.agents.register({
        name: "plan",
        description: "reads and plans, never writes",
        instructions: PLAN_INSTRUCTIONS,
        tools: ["read", "grep", "ls", "glob"],
        posture: "readonly",
        nudges: [{
            on: "*",
            text:
                "The plan agent is read-only on purpose. Finish the plan, then"
                + " /agent default to carry it out.",
        }],
    });
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
