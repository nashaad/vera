export type ContextAssemblyMode = "default" | "bare" | "prompt_only";

export type StartupProfile = ContextAssemblyMode;

export function isContextAssemblyMode(
    value: unknown,
): value is ContextAssemblyMode {
    return value === "default" || value === "bare" || value === "prompt_only";
}

export const isStartupProfile = isContextAssemblyMode;

export function storedContextAssemblyMode(
    mode: ContextAssemblyMode,
): Exclude<ContextAssemblyMode, "default"> | undefined {
    return mode === "default" ? undefined : mode;
}

export const storedStartupProfile = storedContextAssemblyMode;

const BARE_DISABLED_CONTRIBUTIONS = [
    "core.scratchpad",
    "core.scratchpad-state",
    "core.project-instructions",
    "core.memory",
] as const;

const PROMPT_ONLY_DISABLED_CONTRIBUTIONS = [
    "core.narration",
    "core.tools",
    "core.workspace",
    "core.scratchpad",
    "core.date",
    "core.scratchpad-state",
    "core.project-instructions",
    "core.memory",
] as const;

export function disabledContributionsForMode(
    mode: ContextAssemblyMode,
    configured: readonly string[] = [],
): readonly string[] {
    const modeDisabled = mode === "prompt_only"
        ? PROMPT_ONLY_DISABLED_CONTRIBUTIONS
        : mode === "bare"
            ? BARE_DISABLED_CONTRIBUTIONS
            : [];
    return [...new Set([...configured, ...modeDisabled])];
}

export const disabledContributionsForProfile = disabledContributionsForMode;
