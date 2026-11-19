// The values of a home's first config.json. Imports nothing, so a client can read them without the engine's config graph.
export const CONFIG_SCHEMA_VERSION = 1;
export const STARTING_PROVIDER = "openrouter";
export const STARTING_MODEL = "openai/gpt-5.6-sol";
export const STARTING_REASONING_EFFORT = "high";

// What the engine writes for a first save. The approval mode is left out so the first save settles a model and leaves the permissions posture to whoever chooses one.
export function startingConfigFile(): {
    readonly schema_version: typeof CONFIG_SCHEMA_VERSION;
    readonly provider: string;
    readonly model: string;
    readonly reasoning_effort: string;
} {
    return {
        schema_version: CONFIG_SCHEMA_VERSION,
        provider: STARTING_PROVIDER,
        model: STARTING_MODEL,
        reasoning_effort: STARTING_REASONING_EFFORT,
    };
}
