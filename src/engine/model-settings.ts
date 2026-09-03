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
import {
    OVERRIDE_KEYS,
    type OverrideKey,
    type OverrideRow,
} from "./override-rows.ts";

export interface ModelTurnSettings {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    readonly requestedReasoningEffort?: ModelReasoningEffort;
    readonly availableReasoningEfforts?: readonly ModelReasoningEffort[];
    readonly availableModels?: readonly AvailableModel[];
    readonly refreshableProviders?: readonly string[];
    readonly pooled?: readonly PooledModel[];
    /** WebDev Arena snapshot date the TUI prints in Help (`YYYY-MM-DD`). The client must not read the cache itself. */
    readonly webdevArenaSnapshot?: string;
    readonly contextWindow?: number;
    readonly modelContextWindow?: number;
    readonly contextLimit?: number;
    readonly subagentDefault?: SubagentModelDefault;
    readonly reviewerDefault?: ReviewerModelDefault;
    readonly overrides?: OverrideSettings;
}

export interface OverrideSettings {
    readonly rows: readonly OverrideRow[];
}

/** A value per key, or `null` to drop back to the shipped default. */
export type OverrideSettingsPatch = {
    readonly [K in OverrideKey]?: number | string | null;
};

export const OVERRIDE_AGING_LEVELS: readonly string[] = [
    "auto",
    "relaxed",
    "normal",
    "tight",
];

export function isOverrideSettingsPatch(
    value: unknown,
): value is OverrideSettingsPatch {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const patch = value as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
        if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) {
            return false;
        }
    }
    for (const key of OVERRIDE_KEYS) {
        const entry = patch[key];
        if (entry === undefined || entry === null) {
            continue;
        }
        if (key === "toolResultAgingLevel") {
            if (typeof entry !== "string" || !OVERRIDE_AGING_LEVELS.includes(entry)) {
                return false;
            }
            continue;
        }
        if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) {
            return false;
        }
    }
    return true;
}

export interface ReviewerModelSelection {
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ReviewerModelDefault {
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
    readonly contextLimit?: number | null;
    readonly reviewer?: ReviewerSettingsPatch | null;
    readonly overrides?: OverrideSettingsPatch | null;
}

export interface ReviewerSettingsPatch {
    readonly primary: ReviewerModelSelection;
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
        && (settings.refreshableProviders === undefined
            || (Array.isArray(settings.refreshableProviders)
                && settings.refreshableProviders.every((provider) =>
                    typeof provider === "string" && provider.length > 0
                )))
        && (settings.pooled === undefined
            || (Array.isArray(settings.pooled)
                && settings.pooled.every(isPooledModel)))
        && (settings.webdevArenaSnapshot === undefined
            || typeof settings.webdevArenaSnapshot === "string")
        && (settings.contextWindow === undefined
            || (Number.isSafeInteger(settings.contextWindow)
                && (settings.contextWindow as number) > 0))
        && (settings.modelContextWindow === undefined
            || (Number.isSafeInteger(settings.modelContextWindow)
                && (settings.modelContextWindow as number) > 0))
        && (settings.contextLimit === undefined
            || (Number.isSafeInteger(settings.contextLimit)
                && (settings.contextLimit as number) > 0))
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
    if (!providerInfersReasoningEffort(provider)) {
        return [];
    }
    return EVERY_REASONING_EFFORT;
}

function providerInfersReasoningEffort(provider: string): boolean {
    return provider === "openrouter" || provider === "ollama";
}

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
    readonly defaultLevel?: string;
}

function discoveredReasoningEfforts(
    provider: string,
    model: string,
    options: EffectiveCatalogOptions,
): readonly ModelReasoningEffort[] | undefined {
    return effectiveCatalog(provider, options).models
        .find((candidate) => candidate.id === model)
        ?.levels.map((level) => level.id);
}

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

export function effectiveContextWindow(
    declared: number | undefined,
    limit: number | undefined,
): number | undefined {
    if (declared === undefined) return undefined;
    return limit === undefined ? declared : Math.min(declared, limit);
}

export function budgetContextWindow(
    declared: number | undefined,
    limit: number | undefined,
): number | undefined {
    return effectiveContextWindow(declared, limit) ?? limit;
}

interface ModelWindowEntry {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow?: number;
}

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
        && (model.refreshable === undefined
            || typeof model.refreshable === "boolean")
        && isOptionalModelPricing(model.pricing)
        && isOptionalWaScore(model.waScore)
        && (model.onPareto === undefined || typeof model.onPareto === "boolean")
        && (model.imageSupport === undefined
            || typeof model.imageSupport === "boolean")
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
        && isOptionalModelPricing(model.pricing)
        && isOptionalWaScore(model.waScore)
        && (model.onPareto === undefined || typeof model.onPareto === "boolean")
        && (model.imageSupport === undefined
            || typeof model.imageSupport === "boolean")
        && isLevelList(model.levels)
        && (model.defaultLevel === undefined
            || typeof model.defaultLevel === "string");
}

function isOptionalModelPricing(value: unknown): boolean {
    if (value === undefined) return true;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const pricing = value as Record<string, unknown>;
    return isNonNegativeFinite(pricing.input)
        && isNonNegativeFinite(pricing.output)
        && (pricing.cache === undefined || isNonNegativeFinite(pricing.cache));
}

function isOptionalWaScore(value: unknown): boolean {
    return value === undefined
        || (typeof value === "number" && Number.isFinite(value));
}

function isNonNegativeFinite(value: unknown): boolean {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
