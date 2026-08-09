import type { ModelReasoningEffort } from "../model/types.ts";
import {
    effectiveCatalog,
    type EffectiveCatalogOptions,
} from "../model/catalog.ts";
import {
    loadSupportedModelsCatalog,
    verifiedReasoningEfforts,
    type SuggestedModel,
} from "../model/supported-models.ts";
import type {
    AvailableModel,
    PooledModel,
} from "../model/catalog-view.ts";

export interface ModelTurnSettings {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    /**
     * The level the user asked for, present only while it differs from the
     * one in effect because the model does not publish it. Absent is the
     * normal case and is what tells a client the note has cleared, so never
     * fill it in with the effective level.
     *
     * Client-facing only: it describes a substitution, not a stored choice,
     * and is never persisted with the session's settings.
     */
    readonly requestedReasoningEffort?: ModelReasoningEffort;
    /**
     * The efforts the running model accepts, as flat strings. Kept alongside
     * the per-model levels below until clients have moved onto them.
     */
    readonly availableReasoningEfforts?: readonly ModelReasoningEffort[];
    readonly availableModels?: readonly AvailableModel[];
    /**
     * The pool: the models the user admitted, newest first. Separate from
     * `availableModels` because it answers a different question and carries
     * entries that are not currently runnable.
     */
    readonly pooled?: readonly PooledModel[];
    readonly contextWindow?: number;
    /**
     * The settings a spawn without an explicit model will use. This is
     * runtime inspection data, not part of the session's persisted model
     * choice.
     */
    readonly subagentDefault?: SubagentModelDefault;
    /**
     * The reviewer auto mode consults, and the failsafe tried only when the
     * first cannot answer. Runtime inspection data like `subagentDefault`:
     * the reviewer is a user-level setting, not part of the session's own
     * model choice, so it is reported here and stored in the config file.
     */
    readonly reviewerDefault?: ReviewerModelDefault;
}

export interface ReviewerModelSelection {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ReviewerModelDefault {
    /** `agent` means no reviewer is configured, so it runs on the agent's own model. */
    readonly mode: "agent" | "fixed";
    readonly primary?: ReviewerModelSelection;
    readonly fallback?: ReviewerModelSelection;
}

export interface SubagentModelDefault {
    readonly mode: "inherit" | "fixed";
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ModelSettingsPatch {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort | null;
    /**
     * Both reviewer slots, written whole rather than one at a time: a partial
     * patch would have to say what "leave the other slot alone" means when
     * the other slot is empty. `null` clears the reviewer.
     */
    readonly reviewer?: ReviewerSettingsPatch | null;
}

export interface ReviewerSettingsPatch {
    readonly primary: ReviewerModelSelection;
    /** `null` clears the failsafe and leaves the primary alone. */
    readonly fallback?: ReviewerModelSelection | null;
}

export function isReviewerModelSelection(
    value: unknown,
): value is ReviewerModelSelection {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const selection = value as Record<string, unknown>;
    return typeof selection.model === "string"
        && selection.model.trim().length > 0
        && (selection.provider === undefined
            || (typeof selection.provider === "string"
                && selection.provider.trim().length > 0))
        && (selection.reasoningEffort === undefined
            || isModelReasoningEffort(selection.reasoningEffort));
}

export function isReviewerSettingsPatch(
    value: unknown,
): value is ReviewerSettingsPatch {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const patch = value as Record<string, unknown>;
    return isReviewerModelSelection(patch.primary)
        && (patch.fallback === undefined
            || patch.fallback === null
            || isReviewerModelSelection(patch.fallback));
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
        && (settings.requestedReasoningEffort === undefined
            || isModelReasoningEffort(settings.requestedReasoningEffort))
        && (settings.availableReasoningEfforts === undefined
            || (Array.isArray(settings.availableReasoningEfforts)
                && settings.availableReasoningEfforts.every(isModelReasoningEffort)))
        && (settings.availableModels === undefined
            || (Array.isArray(settings.availableModels)
                && settings.availableModels.every(isAvailableModel)))
        && (settings.pooled === undefined
            || (Array.isArray(settings.pooled)
                && settings.pooled.every(isPooledModel)))
        && (settings.contextWindow === undefined
            || (Number.isSafeInteger(settings.contextWindow)
                && (settings.contextWindow as number) > 0))
        && (settings.subagentDefault === undefined
            || isSubagentModelDefault(settings.subagentDefault));
}

function isSubagentModelDefault(value: unknown): value is SubagentModelDefault {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const settings = value as Record<string, unknown>;
    return (settings.mode === "inherit" || settings.mode === "fixed")
        && (settings.provider === undefined
            || (typeof settings.provider === "string"
                && settings.provider.trim().length > 0))
        && (settings.model === undefined
            || (typeof settings.model === "string"
                && settings.model.trim().length > 0))
        && (settings.reasoningEffort === undefined
            || isModelReasoningEffort(settings.reasoningEffort))
        && (settings.mode !== "fixed" || typeof settings.model === "string");
}

const EVERY_REASONING_EFFORT: readonly ModelReasoningEffort[] = [
    "low",
    "medium",
    "high",
    "max",
];

/**
 * The efforts a provider can actually be asked for on this model.
 *
 * Discovery is consulted first because it is the same source the picker offers
 * levels from, and the two disagreeing is a rejection the user cannot act on:
 * the shipped verified list named two levels for `z-ai/glm-5.2` while discovery
 * named four, so choosing the medium the picker had just listed was refused as
 * unsupported. The shipped list is a seed for models discovery has not
 * described, never a ceiling on one it has.
 *
 * A model discovery describes with no levels at all falls through to the
 * shipped list rather than settling on empty, because empty is the answer that
 * removes the dial entirely and a shipped entry is direct evidence the model
 * has one.
 *
 * The optimistic fallback below is only safe where the adapter can cope with an
 * effort it has no mapping for. OpenRouter can: it looks the model up and
 * infers a level. `openai-codex` cannot, so a codex model that neither source
 * describes still has no efforts to offer: naming one would fail the turn
 * rather than degrade it.
 */
export function availableReasoningEfforts(
    provider: string,
    model: string,
    options: EffectiveCatalogOptions = {},
): readonly ModelReasoningEffort[] {
    const discovered = discoveredReasoningEfforts(provider, model, options);
    if (discovered !== undefined && discovered.length > 0) {
        return discovered;
    }
    const verified = verifiedReasoningEfforts(provider, model);
    if (verified.length > 0) {
        return verified;
    }
    if (discovered !== undefined) {
        return discovered;
    }
    if (provider === "openai-codex") {
        return [];
    }
    return EVERY_REASONING_EFFORT;
}

/**
 * The levels published for a model, and the level to settle on when a
 * requested one is not among them.
 *
 * This is the single authority behind both the list a client is served and the
 * list a settings change is checked against. Reading it twice through two
 * different orderings is what let a level be offered in the picker and then
 * refused on the way back in.
 *
 * A ready pool entry wins outright: admission measured what this key can
 * actually send, so it beats both discovery and the shipped list.
 */
export function publishedReasoningLevels(
    provider: string,
    model: string,
    pooled: readonly PooledModel[] = [],
    options: EffectiveCatalogOptions = {},
): PublishedReasoningLevels {
    const poolEntry = pooled.find((entry) =>
        entry.provider === provider
        && entry.model === model
        && entry.available);
    if (poolEntry !== undefined) {
        return {
            efforts: poolEntry.levels.map((level) => level.id),
            ...(poolEntry.defaultLevel === undefined
                ? {}
                : { defaultLevel: poolEntry.defaultLevel }),
        };
    }
    const catalogDefault = effectiveCatalog(provider, options).models
        .find((candidate) => candidate.id === model)
        ?.default_level;
    return {
        efforts: availableReasoningEfforts(provider, model, options),
        ...(catalogDefault === undefined ? {} : { defaultLevel: catalogDefault }),
    };
}

export interface PublishedReasoningLevels {
    readonly efforts: readonly ModelReasoningEffort[];
    /** The model's own default level, when one is recorded. */
    readonly defaultLevel?: string;
}

/**
 * Undefined means discovery has never described this model, which is the only
 * case the optimistic fallback above is for. A model discovery does describe
 * with no levels has no reasoning control at all, and saying so is what keeps
 * the dial off a model that would refuse it: most of OpenRouter's list is
 * chat-only, and the optimistic list used to offer all four efforts on every
 * one of them.
 */
function discoveredReasoningEfforts(
    provider: string,
    model: string,
    options: EffectiveCatalogOptions,
): readonly ModelReasoningEffort[] | undefined {
    return effectiveCatalog(provider, options).models
        .find((candidate) => candidate.id === model)
        ?.levels.map((level) => level.id);
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
    options: EffectiveCatalogOptions = {},
): ModelReasoningEffort | undefined {
    if (requested === undefined || provider === undefined) {
        return requested;
    }
    return availableReasoningEfforts(provider, model, options).length > 0
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
 * The window the model accepts, or undefined for one Vera has no entry for.
 *
 * Undefined is a real answer, not a failure: a model reached through discovery
 * or run locally may have a window nobody has recorded, and a guessed
 * denominator would render a confident percentage of nothing.
 */
export function contextWindowForModel(
    provider: string | undefined,
    model: string,
    ...catalogs: readonly (readonly ModelWindowEntry[] | undefined)[]
): number | undefined {
    if (provider === undefined) {
        return undefined;
    }
    const searched = catalogs.length === 0 ? [availableModels()] : catalogs;
    for (const models of searched) {
        const window = models?.find((candidate) =>
            candidate.provider === provider && candidate.model === model
        )?.contextWindow;
        if (window !== undefined) {
            return window;
        }
    }
    return undefined;
}

/**
 * Discovered models and shipped ones are searched through the same shape: a
 * locally served model's window is measured at discovery and appears in no
 * shipped list.
 */
interface ModelWindowEntry {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow?: number;
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

function isPooledModel(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const model = value as Record<string, unknown>;
    return typeof model.provider === "string"
        && typeof model.model === "string"
        && typeof model.label === "string"
        && (model.poolName === undefined
            || typeof model.poolName === "string")
        && typeof model.available === "boolean"
        && typeof model.verified === "boolean"
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
