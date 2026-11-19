import { configuredModelFallback, type VeraConfig } from "./config.ts";
import type { LoopPolicy } from "./engine/loop-services.ts";

/**
 * The turn-shaping settings a config decides on its own, with no session to
 * consult. The resident host and an SDK run both read them from here, so a
 * new one reaches both without being wired twice.
 */
export type ConfiguredTurnPolicy = Pick<
    LoopPolicy,
    | "modelFallback"
    | "reviewerFallbackEffort"
    | "permissionModes"
    | "permissionRules"
    | "disabledPromptContributions"
    | "promptContributionOrder"
>;

export function configuredTurnPolicy(
    config: VeraConfig,
): ConfiguredTurnPolicy {
    const modelFallback = configuredModelFallback(config);
    return {
        reviewerFallbackEffort: "low",
        ...(modelFallback === undefined ? {} : { modelFallback }),
        ...(config.permission_modes === undefined
            ? {}
            : { permissionModes: config.permission_modes }),
        ...(config.permission_rules === undefined
            ? {}
            : { permissionRules: config.permission_rules }),
        ...(config.disabled_prompt_contributions === undefined ? {} : {
            disabledPromptContributions: config.disabled_prompt_contributions,
        }),
        ...(config.prompt_contribution_order === undefined ? {} : {
            promptContributionOrder: config.prompt_contribution_order,
        }),
    };
}
