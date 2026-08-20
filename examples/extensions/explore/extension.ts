// Exploration as an agent you can wear, plus an opt-in compose-time offer.
// Core does not inspect composer intent; installing this extension enables it.

const EXPLORE_INSTRUCTIONS = `You are exploring, not building.

Investigate the user's question thoroughly. Read and search whatever is
relevant, follow the code paths far enough to distinguish evidence from
inference, and do not write files or start implementation.

Report what you found with concrete file and symbol references. Call out open
questions or uncertainty. When the investigation is complete, stop; the user
decides what happens next.`;

const ASKS_TO_EXPLORE =
    /\b(explore|investigate|research|look into|trace|understand (how|why)|find out)\b/i;

interface ExploreExtensionConfig {
    readonly allowSkillScripts: boolean;
    readonly composeSuggestion: boolean;
    /** Undefined keeps the agent convention: every installed skill. */
    readonly skills?: readonly string[];
}

export function activate(vera: any): void {
    const config = exploreExtensionConfig(vera.config);
    vera.agents.register({
        name: "explore",
        description: "investigates and reports, never writes",
        instructions: EXPLORE_INSTRUCTIONS,
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
                "The explore agent is read-only on purpose. Finish the"
                + " investigation, then /agent default to make changes.",
        }],
    });
}

export function exploreExtensionConfig(value: unknown): ExploreExtensionConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { allowSkillScripts: true, composeSuggestion: true };
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
        composeSuggestion: raw.compose_suggestion !== false,
        ...(skills === undefined ? {} : { skills }),
    };
}

export function activateClient(vera: any): void {
    if (!exploreExtensionConfig(vera.config).composeSuggestion) return;
    vera.compose.registerSuggester({
        agent: "explore",
        hint: "Explore this first?",
        match(text: string) {
            return ASKS_TO_EXPLORE.test(text);
        },
    });
}
