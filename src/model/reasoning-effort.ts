import type { ModelReasoningEffort } from "./types.ts";

export type ReasoningProvider = "openrouter" | "openai-codex";

export type ProviderReasoningEffort =
    | "low"
    | "medium"
    | "high"
    | "max"
    | "xhigh";

export interface ModelReasoningProfile {
    readonly provider: ReasoningProvider;
    readonly model: string;
    readonly efforts: Readonly<Record<
        ModelReasoningEffort,
        ProviderReasoningEffort
    >>;
}

export const MODEL_REASONING_PROFILES: readonly ModelReasoningProfile[] = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        efforts: {
            low: "low",
            medium: "medium",
            high: "high",
            max: "xhigh",
        },
    },
    {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5",
        efforts: {
            low: "low",
            medium: "medium",
            high: "high",
            max: "max",
        },
    },
];

export function providerReasoningEffort(
    provider: ReasoningProvider,
    model: string,
    effort: ModelReasoningEffort,
): ProviderReasoningEffort {
    const profile = MODEL_REASONING_PROFILES.find((candidate) => (
        candidate.provider === provider && candidate.model === model
    ));
    if (profile === undefined) {
        throw new Error(
            `No reasoning effort mapping for ${provider}:${model}`,
        );
    }
    return profile.efforts[effort];
}
