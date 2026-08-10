export type StartupProfile = "default" | "bare" | "prompt_only";

export function isStartupProfile(value: unknown): value is StartupProfile {
    return value === "default" || value === "bare" || value === "prompt_only";
}

export function storedStartupProfile(
    profile: StartupProfile,
): Exclude<StartupProfile, "default"> | undefined {
    return profile === "default" ? undefined : profile;
}

const BARE_DISABLED_CONTRIBUTIONS = [
    "core.scratchpad",
    "core.scratchpad-state",
    "core.project-instructions",
    "core.memory",
] as const;

const PROMPT_ONLY_DISABLED_CONTRIBUTIONS = [
    "core.tools",
    "core.workspace",
    "core.scratchpad",
    "core.date",
    "core.scratchpad-state",
    "core.project-instructions",
    "core.memory",
] as const;

export function disabledContributionsForProfile(
    profile: StartupProfile,
    configured: readonly string[] = [],
): readonly string[] {
    const profileDisabled = profile === "prompt_only"
        ? PROMPT_ONLY_DISABLED_CONTRIBUTIONS
        : profile === "bare"
            ? BARE_DISABLED_CONTRIBUTIONS
            : [];
    return [...new Set([...configured, ...profileDisabled])];
}
