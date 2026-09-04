import { COMPACTION_TRIGGER_FRACTION } from
    "../engine/compaction-scheduler.ts";
import type { ModelReasoningEffort } from "../model/types.ts";
import { isVeraProviderId, type VeraProviderId } from "../config.ts";

export type CatalogProviderId = VeraProviderId;

export interface VeraCatalogModel {
    readonly name: string;
    readonly provider: CatalogProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
}

export interface VeraReviewerProfileConfig {
    readonly model_route?: string;
    readonly policy: string;
    readonly timeout_ms?: number;
}

export interface VeraModelCatalogConfig {
    readonly models: readonly VeraCatalogModel[];
    readonly model_routes: Readonly<Record<string, readonly string[]>>;
    readonly reviewer_profiles: Readonly<
        Record<string, VeraReviewerProfileConfig>
    >;
}

export interface ResolvedReviewerProfile {
    readonly name: string;
    readonly policy: string;
    readonly models: readonly VeraCatalogModel[];
    readonly timeout_ms?: number;
}

export function parseModelCatalogConfig(
    modelsValue: unknown,
    routesValue: unknown,
    reviewersValue: unknown,
    customProviderIds: ReadonlySet<string> = new Set(),
): VeraModelCatalogConfig | undefined {
    if (
        modelsValue === undefined
        && routesValue === undefined
        && reviewersValue === undefined
    ) {
        return {
            models: [],
            model_routes: {},
            reviewer_profiles: {},
        };
    }
    if (
        !Array.isArray(modelsValue)
        || !isRecord(routesValue)
        || !isRecord(reviewersValue)
    ) {
        return undefined;
    }

    const models: VeraCatalogModel[] = [];
    const modelNames = new Set<string>();
    for (const value of modelsValue) {
        const model = parseCatalogModel(value, customProviderIds);
        if (model === undefined || modelNames.has(model.name)) {
            return undefined;
        }
        modelNames.add(model.name);
        models.push(model);
    }

    const routes: Record<string, readonly string[]> = {};
    for (const [name, value] of Object.entries(routesValue)) {
        if (
            !isConfigName(name)
            || !Array.isArray(value)
            || value.length === 0
            || !value.every((entry) =>
                typeof entry === "string" && modelNames.has(entry)
            )
        ) {
            return undefined;
        }
        routes[name] = [...value] as string[];
    }

    const reviewerProfiles: Record<string, VeraReviewerProfileConfig> = {};
    for (const [name, value] of Object.entries(reviewersValue)) {
        const profile = parseReviewerProfile(value, routes);
        if (!isConfigName(name) || profile === undefined) {
            return undefined;
        }
        reviewerProfiles[name] = profile;
    }

    return {
        models,
        model_routes: routes,
        reviewer_profiles: reviewerProfiles,
    };
}

export function resolveModelRoute(
    config: VeraModelCatalogConfig,
    routeName: string,
): readonly VeraCatalogModel[] | undefined {
    const route = config.model_routes[routeName];
    if (route === undefined) {
        return undefined;
    }
    const models = route.flatMap((modelName) => {
        const model = config.models.find((entry) => entry.name === modelName);
        return model === undefined ? [] : [model];
    });
    return models.length === route.length ? models : undefined;
}

export function resolveReviewerProfile(
    config: VeraModelCatalogConfig,
    name: string,
    slotModels?: readonly VeraCatalogModel[],
): ResolvedReviewerProfile | undefined {
    const profile = config.reviewer_profiles[name];
    if (profile === undefined) {
        return undefined;
    }
    const routed = profile.model_route === undefined
        ? undefined
        : resolveModelRoute(config, profile.model_route);
    const models = routed ?? slotModels;
    if (models === undefined || models.length === 0) {
        return undefined;
    }
    return {
        name,
        policy: profile.policy,
        models,
        ...(profile.timeout_ms === undefined
            ? {}
            : { timeout_ms: profile.timeout_ms }),
    };
}

export interface VeraCompactionConfig {
    /**
     * A strategy and its slot routes are set together or not at all. A block
     * that carries only numbers tunes whatever compaction the session would
     * have run anyway.
     */
    readonly strategy?: string;
    readonly models?: Readonly<Record<string, string>>;
    readonly timeout_ms?: number;
    readonly trigger_fraction?: number;
    readonly trigger_tokens?: number;
    readonly target_tokens?: number;
    readonly target_fraction?: number;
    readonly retained_user_turns?: number;
    readonly min_summary_tokens?: number;
    readonly max_attempts?: number;
    readonly summary_word_cap?: number;
    /** The window assumed for a model whose real one is unknown. */
    readonly assumed_window_tokens?: number;
    /** The target fraction used against an assumed window. */
    readonly unknown_target_fraction?: number;
}

export interface ResolvedCompactionProfile {
    readonly strategy: string;
    readonly slots: Readonly<Record<string, readonly VeraCatalogModel[]>>;
    readonly routes: Readonly<Record<string, string>>;
    readonly timeout_ms?: number;
    readonly trigger_fraction?: number;
    readonly trigger_tokens?: number;
    readonly target_tokens?: number;
    readonly retained_user_turns?: number;
}

export function parseCompactionConfig(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): VeraCompactionConfig | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const strategy = value.strategy;
    const models = value.models;
    const timeout = value.timeout_ms;
    const triggerFraction = value.trigger_fraction;
    const triggerTokens = value.trigger_tokens;
    const targetTokens = value.target_tokens;
    const targetFraction = value.target_fraction;
    const unknownTargetFraction = value.unknown_target_fraction;
    const retainedTurns = value.retained_user_turns;
    const minSummaryTokens = value.min_summary_tokens;
    const maxAttempts = value.max_attempts;
    const summaryWordCap = value.summary_word_cap;
    const assumedWindow = value.assumed_window_tokens;
    // One without the other is a typo, not a numbers-only block.
    if ((strategy === undefined) !== (models === undefined)) {
        return undefined;
    }
    if (
        (strategy !== undefined
            && (typeof strategy !== "string" || !isStrategyId(strategy)))
        || (models !== undefined && !isRecord(models))
        || (timeout !== undefined
            && (typeof timeout !== "number"
                || !Number.isSafeInteger(timeout)
                || timeout < 1_000
                || timeout > 600_000))
        || (triggerFraction !== undefined
            && (typeof triggerFraction !== "number"
                || !Number.isFinite(triggerFraction)
                || triggerFraction <= 0
                || triggerFraction > 1))
        || (triggerTokens !== undefined
            && (typeof triggerTokens !== "number"
                || !Number.isSafeInteger(triggerTokens)
                || triggerTokens < 1))
        || (targetTokens !== undefined
            && (typeof targetTokens !== "number"
                || !Number.isSafeInteger(targetTokens)
                || targetTokens < 1))
        || (targetFraction !== undefined
            && (typeof targetFraction !== "number"
                || !Number.isFinite(targetFraction)
                || targetFraction <= 0
                || targetFraction > 1))
        || (unknownTargetFraction !== undefined
            && (typeof unknownTargetFraction !== "number"
                || !Number.isFinite(unknownTargetFraction)
                || unknownTargetFraction <= 0
                || unknownTargetFraction > 1))
        || (retainedTurns !== undefined
            && (typeof retainedTurns !== "number"
                || !Number.isSafeInteger(retainedTurns)
                || retainedTurns < 0))
        || (minSummaryTokens !== undefined
            && (typeof minSummaryTokens !== "number"
                || !Number.isSafeInteger(minSummaryTokens)
                || minSummaryTokens < 1))
        || (maxAttempts !== undefined
            && (typeof maxAttempts !== "number"
                || !Number.isSafeInteger(maxAttempts)
                || maxAttempts < 1))
        || (summaryWordCap !== undefined
            && (typeof summaryWordCap !== "number"
                || !Number.isSafeInteger(summaryWordCap)
                || summaryWordCap < 1))
        || (assumedWindow !== undefined
            && (typeof assumedWindow !== "number"
                || !Number.isSafeInteger(assumedWindow)
                || assumedWindow < 1))
    ) {
        return undefined;
    }
    // Both are fractions of the same window, so a target at or above the
    // trigger compacts straight back to the point that started it. A target
    // set alone is measured against the standing trigger; a trigger set alone
    // is not measured against the standing target, because that would reject
    // a low trigger, which is a shape configs already carry and which only
    // makes compaction eager rather than repeating.
    if (typeof targetFraction === "number") {
        const trigger = typeof triggerFraction === "number"
            ? triggerFraction
            : COMPACTION_TRIGGER_FRACTION;
        if (targetFraction >= trigger) {
            return undefined;
        }
    }
    const slots: Record<string, string> = {};
    for (const [slot, route] of Object.entries(models ?? {})) {
        if (
            !isConfigName(slot)
            || typeof route !== "string"
            || routes[route] === undefined
        ) {
            return undefined;
        }
        slots[slot] = route;
    }
    return {
        ...(strategy === undefined
            ? {}
            : { strategy: strategy as string, models: slots }),
        ...(timeout === undefined ? {} : { timeout_ms: timeout }),
        ...(triggerFraction === undefined
            ? {}
            : { trigger_fraction: triggerFraction }),
        ...(triggerTokens === undefined
            ? {}
            : { trigger_tokens: triggerTokens }),
        ...(targetTokens === undefined
            ? {}
            : { target_tokens: targetTokens }),
        ...(targetFraction === undefined
            ? {}
            : { target_fraction: targetFraction }),
        ...(unknownTargetFraction === undefined
            ? {}
            : { unknown_target_fraction: unknownTargetFraction }),
        ...(retainedTurns === undefined
            ? {}
            : { retained_user_turns: retainedTurns }),
        ...(minSummaryTokens === undefined
            ? {}
            : { min_summary_tokens: minSummaryTokens }),
        ...(maxAttempts === undefined ? {} : { max_attempts: maxAttempts }),
        ...(summaryWordCap === undefined
            ? {}
            : { summary_word_cap: summaryWordCap }),
        ...(assumedWindow === undefined
            ? {}
            : { assumed_window_tokens: assumedWindow }),
    };
}

export function resolveCompactionProfile(
    config: VeraModelCatalogConfig,
    compaction: VeraCompactionConfig,
): ResolvedCompactionProfile | undefined {
    if (compaction.strategy === undefined || compaction.models === undefined) {
        return undefined;
    }
    const slots: Record<string, readonly VeraCatalogModel[]> = {};
    const routes: Record<string, string> = {};
    for (const [slot, routeName] of Object.entries(compaction.models)) {
        const models = resolveModelRoute(config, routeName);
        if (models === undefined) {
            return undefined;
        }
        slots[slot] = models;
        routes[slot] = routeName;
    }
    return {
        strategy: compaction.strategy,
        slots,
        routes,
        ...(compaction.timeout_ms === undefined
            ? {}
            : { timeout_ms: compaction.timeout_ms }),
        ...(compaction.trigger_fraction === undefined
            ? {}
            : { trigger_fraction: compaction.trigger_fraction }),
        ...(compaction.trigger_tokens === undefined
            ? {}
            : { trigger_tokens: compaction.trigger_tokens }),
        ...(compaction.target_tokens === undefined
            ? {}
            : { target_tokens: compaction.target_tokens }),
        ...(compaction.retained_user_turns === undefined
            ? {}
            : { retained_user_turns: compaction.retained_user_turns }),
    };
}

export function derivedModelName(
    provider: CatalogProviderId,
    model: string,
    reasoningEffort?: ModelReasoningEffort,
): string {
    return [model, reasoningEffort, provider]
        .filter((part): part is string => part !== undefined)
        .join("_")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

export function parseCatalogModel(
    value: unknown,
    customProviderIds: ReadonlySet<string> = new Set(),
): VeraCatalogModel | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const provider = value.provider;
    const model = value.model;
    const effort = value.reasoning_effort;
    if (
        !isProvider(provider, customProviderIds)
        || typeof model !== "string"
        || model.trim().length === 0
        || (effort !== undefined && !isReasoningEffort(effort))
        || (value.name !== undefined
            && (typeof value.name !== "string" || !isConfigName(value.name)))
    ) {
        return undefined;
    }
    const name = typeof value.name === "string"
        ? value.name
        : derivedModelName(provider, model.trim(), effort);
    if (!isConfigName(name)) {
        return undefined;
    }
    return {
        name,
        provider,
        model: model.trim(),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
    };
}

function parseReviewerProfile(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): VeraReviewerProfileConfig | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const route = value.model_route;
    const policy = value.policy;
    const timeout = value.timeout_ms;
    if (
        (route !== undefined
            && (typeof route !== "string" || routes[route] === undefined))
        || typeof policy !== "string"
        || policy.trim().length === 0
        || (timeout !== undefined
            && (typeof timeout !== "number"
                || !Number.isInteger(timeout)
                || timeout < 1_000
                || timeout > 600_000))
    ) {
        return undefined;
    }
    return {
        ...(route === undefined ? {} : { model_route: route as string }),
        policy: policy.trim(),
        ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(
    value: unknown,
    customProviderIds: ReadonlySet<string>,
): value is CatalogProviderId {
    return typeof value === "string"
        && (isVeraProviderId(value) || customProviderIds.has(value));
}

function isReasoningEffort(value: unknown): value is ModelReasoningEffort {
    return typeof value === "string" && value.length > 0;
}

function isConfigName(value: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function isStrategyId(value: string): boolean {
    const [publisher, local, ...rest] = value.split("/");
    return rest.length === 0
        && publisher !== undefined
        && local !== undefined
        && isConfigName(publisher)
        && isConfigName(local);
}
