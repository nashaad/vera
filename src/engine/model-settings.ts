import type { ModelReasoningEffort } from "../model/types.ts";
import {
    loadSupportedModelsCatalog,
    verifiedReasoningEfforts,
    type SuggestedModel,
} from "../model/supported-models.ts";
import type {
    AvailableModel,
    StashedModel,
} from "../model/catalog-view.ts";

export interface ModelTurnSettings {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    /**
     * The efforts the running model accepts, as flat strings. Kept alongside
     * the per-model levels below until clients have moved onto them.
     */
    readonly availableReasoningEfforts?: readonly ModelReasoningEffort[];
    readonly availableModels?: readonly AvailableModel[];
    /**
     * The models the user keeps, most recently used first. Separate from
     * `availableModels` because it answers a different question and carries
     * entries that are not currently runnable.
     */
    readonly stash?: readonly StashedModel[];
    readonly contextWindow?: number;
}

export interface ModelSettingsPatch {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort | null;
}

export function isModelTurnSettings(value: unknown): value is ModelTurnSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const settings = value as Record<string, unknown>;
    return (settings.provider === undefined
            || (typeof settings.provider === "string"
                && settings.provider.trim().length > 0))
        && typeof settings.model === "string"
        && settings.model.trim().length > 0
        && (settings.reasoningEffort === undefined
            || isModelReasoningEffort(settings.reasoningEffort))
        && (settings.availableReasoningEfforts === undefined
            || (Array.isArray(settings.availableReasoningEfforts)
                && settings.availableReasoningEfforts.every(isModelReasoningEffort)))
        && (settings.availableModels === undefined
            || (Array.isArray(settings.availableModels)
                && settings.availableModels.every(isAvailableModel)))
        && (settings.stash === undefined
            || (Array.isArray(settings.stash)
                && settings.stash.every(isStashedModel)))
        && (settings.contextWindow === undefined
            || (Number.isSafeInteger(settings.contextWindow)
                && (settings.contextWindow as number) > 0));
}

const EVERY_REASONING_EFFORT: readonly ModelReasoningEffort[] = [
    "off",
    "low",
    "medium",
    "high",
    "max",
];

/**
 * The efforts a provider can actually be asked for on this model.
 *
 * The optimistic fallback is only safe where the adapter can cope with an
 * effort it has no mapping for. OpenRouter can: it looks the model up and
 * infers a level. `openai-codex` cannot, so a codex model with no verified
 * catalog entry has no known levels at all: offering one would fail the
 * turn rather than degrade it. Such a model therefore has no efforts to
 * offer, until a catalog loader supplies its level list.
 */
export function availableReasoningEfforts(
    provider: string,
    model: string,
): readonly ModelReasoningEffort[] {
    const verified = verifiedReasoningEfforts(provider, model);
    if (verified.length > 0) {
        return verified;
    }
    if (provider === "openai-codex") {
        return [];
    }
    return EVERY_REASONING_EFFORT;
}

/**
 * The reasoning effort to carry onto a model the user did not choose: a
 * fallback target, or settings restored from config.
 *
 * The test is emptiness rather than membership on purpose. A narrower list is
 * the menu a person is offered, not the limit of what the adapter can resolve,
 * and OpenRouter infers a level for an effort its catalog entry does not list.
 * Only a model with no efforts at all cannot be asked, and asking anyway fails
 * the request inside the adapter.
 */
export function reasoningEffortForModel(
    provider: string | undefined,
    model: string,
    requested: ModelReasoningEffort | undefined,
): ModelReasoningEffort | undefined {
    if (requested === undefined || provider === undefined) {
        return requested;
    }
    return availableReasoningEfforts(provider, model).length > 0
        ? requested
        : undefined;
}

export function availableModels(): readonly SuggestedModel[] {
    return loadSupportedModelsCatalog().verified_models
        .map((model) => ({
            provider: model.provider,
            model: model.model,
            label: model.label,
            description: model.description,
            contextWindow: model.context_window,
        }));
}

/**
 * `levels` is required, and an entry without it is rejected rather than read
 * as empty. Do not loosen this: empty already means "this model has no
 * reasoning control at all", so accepting absent and normalising it would make
 * a producer that forgot the field render every model with no levels at all.
 * A rejected update is visible and debuggable; a silently missing level list
 * is neither.
 */
function isAvailableModel(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const model = value as Record<string, unknown>;
    return typeof model.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && typeof model.description === "string"
        && (model.contextWindow === undefined
            || (Number.isSafeInteger(model.contextWindow)
                && (model.contextWindow as number) > 0))
        && isLevelList(model.levels)
        && (model.defaultLevel === undefined
            || typeof model.defaultLevel === "string");
}

function isStashedModel(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const model = value as Record<string, unknown>;
    return typeof model.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && typeof model.available === "boolean"
        && (model.description === undefined
            || typeof model.description === "string")
        && (model.contextWindow === undefined
            || (Number.isSafeInteger(model.contextWindow)
                && (model.contextWindow as number) > 0))
        && isLevelList(model.levels)
        && (model.defaultLevel === undefined
            || typeof model.defaultLevel === "string");
}

function isLevelList(value: unknown): boolean {
    return Array.isArray(value) && value.every(isReasoningLevel);
}

function isReasoningLevel(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const level = value as Record<string, unknown>;
    return typeof level.id === "string"
        && typeof level.label === "string"
        && (level.description === undefined
            || typeof level.description === "string");
}

export function isModelReasoningEffort(
    value: unknown,
): value is ModelReasoningEffort {
    return typeof value === "string" && value.length > 0;
}
