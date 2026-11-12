import type { ModelReasoningEffort } from "../model/types.ts";
import type { VeraProviderId } from "../config.ts";
import { isVeraProviderId } from "../providers/builtin-id.ts";
import { configProblem, expectedValue, keyValue } from "./diagnostic.ts";

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
    if (!Array.isArray(modelsValue)) {
        return configProblem("models", catalogPartProblem("a list of models", modelsValue));
    }
    if (!isRecord(routesValue)) {
        return configProblem(
            "model_routes",
            catalogPartProblem("an object of routes", routesValue),
        );
    }
    if (!isRecord(reviewersValue)) {
        return configProblem(
            "reviewer_profiles",
            catalogPartProblem("an object of reviewer profiles", reviewersValue),
        );
    }

    const models: VeraCatalogModel[] = [];
    const modelNames = new Set<string>();
    for (const [index, value] of modelsValue.entries()) {
        const field = `models[${index}]`;
        const model = parseCatalogModel(value, customProviderIds, field);
        if (model === undefined) {
            return undefined;
        }
        if (modelNames.has(model.name)) {
            return configProblem(
                field,
                `name ${JSON.stringify(model.name)} is already used by an earlier model`,
            );
        }
        modelNames.add(model.name);
        models.push(model);
    }

    const routes: Record<string, readonly string[]> = {};
    for (const [name, value] of Object.entries(routesValue)) {
        const field = `model_routes.${name}`;
        if (!isConfigName(name)) {
            return configProblem(
                "model_routes",
                `route name ${JSON.stringify(name)} must use lowercase letters, digits, - and _`,
            );
        }
        if (!Array.isArray(value) || value.length === 0) {
            return configProblem(
                field,
                expectedValue("a non-empty list of model names", value),
            );
        }
        const unknown = value.find((entry) =>
            typeof entry !== "string" || !modelNames.has(entry)
        );
        if (unknown !== undefined) {
            return configProblem(
                field,
                `${JSON.stringify(unknown)} is not a name in models`,
            );
        }
        routes[name] = [...value] as string[];
    }

    const reviewerProfiles: Record<string, VeraReviewerProfileConfig> = {};
    for (const [name, value] of Object.entries(reviewersValue)) {
        if (!isConfigName(name)) {
            return configProblem(
                "reviewer_profiles",
                `profile name ${JSON.stringify(name)} must use lowercase letters, digits, - and _`,
            );
        }
        const profile = parseReviewerProfile(value, routes, `reviewer_profiles.${name}`);
        if (profile === undefined) {
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

function catalogPartProblem(expected: string, actual: unknown): string {
    return actual === undefined
        ? `expected ${expected}; models, model_routes and reviewer_profiles are set together`
        : expectedValue(expected, actual);
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

export interface VeraCompactionRung {
    readonly strategy: string;
    readonly models?: Readonly<Record<string, string>>;
    readonly timeout_ms?: number;
    readonly reasoning_effort?: ModelReasoningEffort;
}

export interface VeraCompactionConfig {
    /**
     * Strategies in the order they are tried. Absent means the bundled
     * default ladder. The legacy `strategy`, `models` and `timeout_ms` keys
     * are read as a one-rung ladder and are not kept in the parsed value.
     */
    readonly ladder?: readonly VeraCompactionRung[];
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

export interface ResolvedCompactionRung {
    readonly strategy: string;
    readonly slots: Readonly<Record<string, readonly VeraCatalogModel[]>>;
    readonly routes: Readonly<Record<string, string>>;
    readonly timeout_ms?: number;
    readonly reasoning_effort?: ModelReasoningEffort;
}

export interface ResolvedCompactionProfile {
    readonly ladder: readonly ResolvedCompactionRung[];
    readonly trigger_fraction?: number;
    readonly trigger_tokens?: number;
    readonly target_tokens?: number;
    readonly retained_user_turns?: number;
}

interface CompactionNumber {
    readonly key: keyof VeraCompactionConfig & string;
    readonly expected: string;
    readonly valid: (value: number) => boolean;
}

const isFraction = (value: number): boolean =>
    Number.isFinite(value) && value > 0 && value <= 1;
const isCount = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= 1;

const COMPACTION_NUMBERS: readonly CompactionNumber[] = [
    { key: "trigger_fraction", expected: "a number above 0 and up to 1", valid: isFraction },
    { key: "trigger_tokens", expected: "a whole number of tokens, 1 or more", valid: isCount },
    { key: "target_tokens", expected: "a whole number of tokens, 1 or more", valid: isCount },
    { key: "target_fraction", expected: "a number above 0 and up to 1", valid: isFraction },
    {
        key: "unknown_target_fraction",
        expected: "a number above 0 and up to 1",
        valid: isFraction,
    },
    {
        key: "retained_user_turns",
        expected: "a whole number, 0 or more",
        valid: (value) => Number.isSafeInteger(value) && value >= 0,
    },
    { key: "min_summary_tokens", expected: "a whole number of tokens, 1 or more", valid: isCount },
    { key: "max_attempts", expected: "a whole number, 1 or more", valid: isCount },
    { key: "summary_word_cap", expected: "a whole number of words, 1 or more", valid: isCount },
    {
        key: "assumed_window_tokens",
        expected: "a whole number of tokens, 1 or more",
        valid: isCount,
    },
];

const RUNG_KEYS = new Set([
    "strategy",
    "models",
    "timeout_ms",
    "reasoning_effort",
]);

interface OptionalNumber {
    readonly value?: number;
}

export function parseCompactionConfig(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): VeraCompactionConfig | undefined {
    if (!isRecord(value)) {
        return configProblem("compaction", expectedValue("an object", value));
    }
    const legacyStrategy = value.strategy;
    const legacyModels = value.models;
    const legacyTimeout = value.timeout_ms;
    const legacy = legacyStrategy !== undefined || legacyModels !== undefined;
    // A ladder and the legacy keys declare the same thing, so only one may appear.
    if (value.ladder !== undefined && (legacy || legacyTimeout !== undefined)) {
        return configProblem(
            "compaction",
            "set ladder or the legacy strategy, models and timeout_ms keys, not both",
        );
    }
    // Strategy and models are a pair. A timeout with no strategy never reached a session.
    if (legacy && (legacyStrategy === undefined || legacyModels === undefined)) {
        return configProblem(
            "compaction",
            `${legacyStrategy === undefined ? "strategy" : "models"} is missing; strategy and models are set together`,
        );
    }
    if (!legacy && legacyTimeout !== undefined
        && optionalNumber(legacyTimeout, isTimeoutMs) === undefined) {
        return configProblem(
            "compaction.timeout_ms",
            expectedValue("a whole number from 1000 to 600000", legacyTimeout),
        );
    }
    let ladder: readonly VeraCompactionRung[] | undefined;
    if (value.ladder !== undefined) {
        ladder = parseLadder(value.ladder, routes);
        if (ladder === undefined) {
            return undefined;
        }
    } else if (legacy) {
        const rung = parseRung(
            {
                strategy: legacyStrategy,
                models: legacyModels,
                timeout_ms: legacyTimeout,
            },
            routes,
            "compaction",
        );
        if (rung === undefined) {
            return undefined;
        }
        ladder = [rung];
    }
    const numbers: Record<string, number> = {};
    for (const entry of COMPACTION_NUMBERS) {
        const number = value[entry.key];
        if (number === undefined) continue;
        if (typeof number !== "number" || !entry.valid(number)) {
            return configProblem(
                `compaction.${entry.key}`,
                expectedValue(entry.expected, number),
            );
        }
        numbers[entry.key] = number;
    }
    return {
        ...(ladder === undefined ? {} : { ladder }),
        ...numbers,
    };
}

function parseLadder(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): readonly VeraCompactionRung[] | undefined {
    if (!Array.isArray(value) || value.length === 0) {
        return configProblem(
            "compaction.ladder",
            expectedValue("a non-empty list of rungs", value),
        );
    }
    const ladder: VeraCompactionRung[] = [];
    for (const [index, rung] of value.entries()) {
        const parsed = parseRung(rung, routes, `compaction.ladder[${index}]`);
        if (parsed === undefined) {
            return undefined;
        }
        ladder.push(parsed);
    }
    return ladder;
}

function parseRung(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
    field: string,
): VeraCompactionRung | undefined {
    if (!isRecord(value)) {
        return configProblem(field, expectedValue("an object", value));
    }
    const unknownKey = Object.keys(value).find((key) => !RUNG_KEYS.has(key));
    if (unknownKey !== undefined) {
        return configProblem(
            `${field}.${unknownKey}`,
            `unknown key; a rung accepts ${[...RUNG_KEYS].join(", ")}`,
        );
    }
    const strategy = value.strategy;
    if (typeof strategy !== "string" || !isStrategyId(strategy)) {
        return configProblem(
            `${field}.strategy`,
            keyValue("strategy", "a name like publisher/strategy", strategy),
        );
    }
    const timeout = optionalNumber(value.timeout_ms, isTimeoutMs);
    if (timeout === undefined) {
        return configProblem(
            `${field}.timeout_ms`,
            expectedValue("a whole number from 1000 to 600000", value.timeout_ms),
        );
    }
    const effort = value.reasoning_effort;
    if (effort !== undefined && !isReasoningEffort(effort)) {
        return configProblem(
            `${field}.reasoning_effort`,
            keyValue("reasoning_effort", "a non-empty string", effort),
        );
    }
    const models = value.models === undefined
        ? undefined
        : parseSlotRoutes(value.models, routes, `${field}.models`);
    if (value.models !== undefined && models === undefined) {
        return undefined;
    }
    return {
        strategy,
        ...(models === undefined ? {} : { models }),
        ...withoutUndefined({
            timeout_ms: timeout.value,
            reasoning_effort: effort,
        }),
    };
}

function parseSlotRoutes(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
    field: string,
): Record<string, string> | undefined {
    if (!isRecord(value)) {
        return configProblem(field, expectedValue("an object of slot names to routes", value));
    }
    const slots: Record<string, string> = {};
    for (const [slot, route] of Object.entries(value)) {
        if (!isConfigName(slot)) {
            return configProblem(
                field,
                `slot name ${JSON.stringify(slot)} must use lowercase letters, digits, - and _`,
            );
        }
        if (typeof route !== "string" || routes[route] === undefined) {
            return configProblem(
                `${field}.${slot}`,
                expectedValue("a name in model_routes", route),
            );
        }
        slots[slot] = route;
    }
    return slots;
}

function optionalNumber(
    value: unknown,
    valid: (n: number) => boolean,
): OptionalNumber | undefined {
    if (value === undefined) {
        return {};
    }
    return typeof value === "number" && valid(value) ? { value } : undefined;
}

function isTimeoutMs(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1_000 && value <= 600_000;
}

function withoutUndefined<T extends Record<string, unknown>>(
    value: T,
): Partial<T> {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as Partial<T>;
}

export function resolveCompactionProfile(
    config: VeraModelCatalogConfig,
    compaction: VeraCompactionConfig,
): ResolvedCompactionProfile | undefined {
    if (compaction.ladder === undefined) {
        return undefined;
    }
    const ladder: ResolvedCompactionRung[] = [];
    for (const rung of compaction.ladder) {
        const slots: Record<string, readonly VeraCatalogModel[]> = {};
        const routes: Record<string, string> = {};
        for (const [slot, routeName] of Object.entries(rung.models ?? {})) {
            const models = resolveModelRoute(config, routeName);
            if (models === undefined) {
                return undefined;
            }
            slots[slot] = models;
            routes[slot] = routeName;
        }
        ladder.push({
            strategy: rung.strategy,
            slots,
            routes,
            ...(rung.timeout_ms === undefined
                ? {}
                : { timeout_ms: rung.timeout_ms }),
            ...(rung.reasoning_effort === undefined
                ? {}
                : { reasoning_effort: rung.reasoning_effort }),
        });
    }
    return {
        ladder,
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
    field = "models",
): VeraCatalogModel | undefined {
    if (!isRecord(value)) {
        return configProblem(field, expectedValue("an object", value));
    }
    const provider = value.provider;
    const model = value.model;
    const effort = value.reasoning_effort;
    if (!isProvider(provider, customProviderIds)) {
        return configProblem(
            field,
            keyValue("provider", "a provider Vera ships or a name declared in providers", provider),
        );
    }
    if (typeof model !== "string" || model.trim().length === 0) {
        return configProblem(
            field,
            keyValue("model", "a non-empty string", model),
        );
    }
    if (effort !== undefined && !isReasoningEffort(effort)) {
        return configProblem(
            field,
            keyValue("reasoning_effort", "a non-empty string", effort),
        );
    }
    if (
        value.name !== undefined
        && (typeof value.name !== "string" || !isConfigName(value.name))
    ) {
        return configProblem(
            field,
            `name must use lowercase letters, digits, - and _, found ${JSON.stringify(value.name)}`,
        );
    }
    const name = typeof value.name === "string"
        ? value.name
        : derivedModelName(provider, model.trim(), effort);
    if (!isConfigName(name)) {
        return configProblem(
            field,
            `no usable name can be derived from ${JSON.stringify(model)}; set name`,
        );
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
    field: string,
): VeraReviewerProfileConfig | undefined {
    if (!isRecord(value)) {
        return configProblem(field, expectedValue("an object", value));
    }
    const route = value.model_route;
    const policy = value.policy;
    const timeout = value.timeout_ms;
    if (route !== undefined && (typeof route !== "string" || routes[route] === undefined)) {
        return configProblem(
            field,
            keyValue("model_route", "a name in model_routes", route),
        );
    }
    if (typeof policy !== "string" || policy.trim().length === 0) {
        return configProblem(
            field,
            keyValue("policy", "a non-empty string", policy),
        );
    }
    if (
        timeout !== undefined
        && (typeof timeout !== "number"
            || !Number.isInteger(timeout)
            || timeout < 1_000
            || timeout > 600_000)
    ) {
        return configProblem(
            field,
            keyValue("timeout_ms", "a whole number from 1000 to 600000", timeout),
        );
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
