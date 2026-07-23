import type { ModelReasoningEffort } from "../model/types.ts";

export type CatalogProviderId = "openrouter" | "openai-codex" | "ollama";

export interface VeraCatalogModel {
    readonly name: string;
    readonly provider: CatalogProviderId;
    readonly model: string;
    readonly reasoning_effort?: ModelReasoningEffort;
}

export interface VeraReviewerProfileConfig {
    readonly model_route: string;
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
        const model = parseCatalogModel(value);
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

export function resolveReviewerProfile(
    config: VeraModelCatalogConfig,
    name: string,
): ResolvedReviewerProfile | undefined {
    const profile = config.reviewer_profiles[name];
    if (profile === undefined) {
        return undefined;
    }
    const route = config.model_routes[profile.model_route];
    if (route === undefined) {
        return undefined;
    }
    const models = route.flatMap((modelName) => {
        const model = config.models.find((entry) => entry.name === modelName);
        return model === undefined ? [] : [model];
    });
    if (models.length !== route.length) {
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

function parseCatalogModel(value: unknown): VeraCatalogModel | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const provider = value.provider;
    const model = value.model;
    const effort = value.reasoning_effort;
    if (
        !isProvider(provider)
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
        typeof route !== "string"
        || routes[route] === undefined
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
        model_route: route,
        policy: policy.trim(),
        ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is CatalogProviderId {
    return value === "openrouter"
        || value === "openai-codex"
        || value === "ollama";
}

function isReasoningEffort(value: unknown): value is ModelReasoningEffort {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}

function isConfigName(value: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}
