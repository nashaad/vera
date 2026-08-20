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
    /** Absent means the profile takes whatever the reviewer slot holds. */
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

/**
 * A named route resolved to catalog entries, in preference order. Anything
 * that binds a model for internal work goes through here rather than reading
 * `model_routes` itself, so a route that names a model the catalog dropped
 * fails the same way everywhere instead of resolving to a short list.
 */
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

/**
 * A profile's policy and timeout are its own. Only its routing may come from
 * elsewhere, which is why `slotModels` is passed in rather than the profile
 * being replaced by a slot: permission modes name profiles, and those names
 * have to keep meaning what they meant.
 */
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

/**
 * Which strategy compacts this session, and which route answers each model
 * slot the strategy declares. Slots are named by the strategy, so config maps
 * names to routes without either side knowing the other's catalog.
 */
export interface VeraCompactionConfig {
    readonly strategy: string;
    readonly models: Readonly<Record<string, string>>;
    readonly timeout_ms?: number;
    /** Share of a known window at which compaction fires. */
    readonly trigger_fraction?: number;
    /**
     * Absolute token count at which compaction fires, whichever comes first.
     * The only bound that applies when the model's window is unknown.
     */
    readonly trigger_tokens?: number;
    /** Token target for a session whose window is unknown. */
    readonly target_tokens?: number;
    /**
     * Complete user turns kept verbatim after the boundary, when they fit.
     * A preference, not a floor: a turn too large for the target is cut into
     * rather than compaction declining to run.
     */
    readonly retained_user_turns?: number;
}

export interface ResolvedCompactionProfile {
    readonly strategy: string;
    /** Slot name to the route's models, in preference order. */
    readonly slots: Readonly<Record<string, readonly VeraCatalogModel[]>>;
    /** Slot name to the route it came from. Diagnostic only. */
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
    const retainedTurns = value.retained_user_turns;
    if (
        typeof strategy !== "string"
        || !isStrategyId(strategy)
        || !isRecord(models)
        || (timeout !== undefined
            && (typeof timeout !== "number"
                || !Number.isInteger(timeout)
                || timeout < 1_000
                || timeout > 600_000))
        || (triggerFraction !== undefined
            && (typeof triggerFraction !== "number"
                || !Number.isFinite(triggerFraction)
                || triggerFraction <= 0
                || triggerFraction > 1))
        || (triggerTokens !== undefined
            && (typeof triggerTokens !== "number"
                || !Number.isInteger(triggerTokens)
                || triggerTokens < 1))
        || (targetTokens !== undefined
            && (typeof targetTokens !== "number"
                || !Number.isInteger(targetTokens)
                || targetTokens < 1))
        || (retainedTurns !== undefined
            && (typeof retainedTurns !== "number"
                || !Number.isInteger(retainedTurns)
                || retainedTurns < 0))
    ) {
        return undefined;
    }
    const slots: Record<string, string> = {};
    for (const [slot, route] of Object.entries(models)) {
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
        strategy,
        models: slots,
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
        ...(retainedTurns === undefined
            ? {}
            : { retained_user_turns: retainedTurns }),
    };
}

export function resolveCompactionProfile(
    config: VeraModelCatalogConfig,
    compaction: VeraCompactionConfig,
): ResolvedCompactionProfile | undefined {
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

/** `<publisher>/<local-id>`, the same shape extension contributions carry. */
function isStrategyId(value: string): boolean {
    const [publisher, local, ...rest] = value.split("/");
    return rest.length === 0
        && publisher !== undefined
        && local !== undefined
        && isConfigName(publisher)
        && isConfigName(local);
}
