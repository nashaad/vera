import {
    STARTING_MODEL,
    STARTING_PROVIDER,
    type VeraConfig,
} from "../../src/config.ts";

export interface OnboardingModelDefaultOptions {
    readonly config: Pick<VeraConfig, "provider" | "model">;
    readonly provider?: string;
    readonly currentProvider?: string;
    readonly hasAssignedDefault: boolean;
    readonly modelUsedBefore: boolean;
}

export interface OnboardingModelState {
    readonly modelSettings?: {
        readonly model?: string;
        readonly provider?: string;
    };
    readonly modelSettingsOrigin?: "agent-default" | "user";
    readonly entries: readonly {
        readonly kind: string;
        readonly text?: string;
    }[];
}

export function shouldAdoptFirstOnboardingModel(
    config: Pick<VeraConfig, "provider" | "model">,
    hasAssignedDefault: boolean,
    modelUsedBefore: boolean,
): boolean {
    return config.provider === STARTING_PROVIDER
        && config.model === STARTING_MODEL
        && !hasAssignedDefault
        && !modelUsedBefore;
}

export function shouldAdoptOnboardingModel(
    options: OnboardingModelDefaultOptions,
): boolean {
    if (options.modelUsedBefore) return false;
    if (
        options.provider !== undefined
        && options.provider === options.currentProvider
    ) {
        return true;
    }
    return shouldAdoptFirstOnboardingModel(
        options.config,
        options.hasAssignedDefault,
        false,
    );
}

export function shouldAdoptWizardModel(
    config: Pick<VeraConfig, "provider" | "model">,
    state: OnboardingModelState,
    provider: string | undefined,
): boolean {
    const settings = state.modelSettings;
    const settingsDiffer = settings?.model !== undefined && (
        settings.model !== config.model
        || (settings.provider ?? config.provider) !== config.provider
    );
    return shouldAdoptOnboardingModel({
        config,
        provider,
        currentProvider: config.provider,
        hasAssignedDefault: state.modelSettingsOrigin === "user" || settingsDiffer,
        modelUsedBefore: state.entries.some((entry) =>
            entry.kind === "assistant" && (entry.text ?? "").trim().length > 0
        ),
    });
}
