import type { ModelReasoningEffort } from "./types.ts";
import { verifiedModel } from "./supported-models.ts";

export type ReasoningProvider = "openrouter" | "openai-codex";
export type ProviderReasoningEffort = string;

export interface ReasoningSelection {
    readonly requested: ModelReasoningEffort;
    readonly providerEffort: ProviderReasoningEffort;
    readonly inferred: boolean;
}

export interface ModelReasoningProfile {
    readonly provider: ReasoningProvider;
    readonly model: string;
    readonly efforts: Readonly<Record<
        ModelReasoningEffort,
        ProviderReasoningEffort
    >>;
}

export interface ResolveReasoningOptions {
    readonly fetch?: FetchRequest;
    readonly supportedEfforts?: readonly string[];
}

export interface FetchRequest {
    (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export const MODEL_REASONING_PROFILES: readonly ModelReasoningProfile[] = [
    {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        efforts: {
            off: "none",
            low: "low",
            medium: "medium",
            high: "high",
            max: "xhigh",
        },
    },
    {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5",
        efforts: {
            off: "none",
            low: "low",
            medium: "medium",
            high: "high",
            max: "max",
        },
    },
];

const VERA_ORDER: readonly Exclude<ModelReasoningEffort, "off">[] = [
    "low",
    "medium",
    "high",
    "max",
];

const openRouterEffortRequests = new Map<string, Promise<readonly string[]>>();

export async function resolveReasoningSelection(
    provider: ReasoningProvider,
    model: string,
    requested: ModelReasoningEffort,
    options: ResolveReasoningOptions = {},
): Promise<ReasoningSelection> {
    if (provider === "openrouter") {
        const verified = verifiedModel(provider, model)?.reasoning.find(
            (combination) => combination.vera_effort === requested,
        );
        if (verified !== undefined) {
            return {
                requested,
                providerEffort: verified.provider_effort,
                inferred: false,
            };
        }
    }
    const profile = MODEL_REASONING_PROFILES.find((candidate) => (
        candidate.provider === provider && candidate.model === model
    ));
    if (profile !== undefined) {
        return {
            requested,
            providerEffort: profile.efforts[requested],
            inferred: false,
        };
    }

    if (provider !== "openrouter") {
        throw new Error(`No reasoning effort mapping for ${provider}:${model}`);
    }

    const supportedEfforts = options.supportedEfforts
        ?? await loadOpenRouterEfforts(model, options.fetch ?? globalThis.fetch);
    return inferReasoningSelection(model, requested, supportedEfforts);
}

function inferReasoningSelection(
    model: string,
    requested: ModelReasoningEffort,
    supportedDescending: readonly string[],
): ReasoningSelection {
    const supported = uniqueNonEmptyStrings(supportedDescending);
    if (requested === "off") {
        if (!supported.includes("none")) {
            throw new Error(
                `OpenRouter model ${model} does not explicitly support reasoning off`,
            );
        }
        return { requested, providerEffort: "none", inferred: true };
    }

    if (supported.includes(requested)) {
        return { requested, providerEffort: requested, inferred: true };
    }

    const enabledAscending = supported
        .filter((effort) => effort !== "none")
        .reverse();
    if (enabledAscending.length === 0) {
        throw new Error(`OpenRouter model ${model} has no reasoning effort levels`);
    }

    const requestedIndex = VERA_ORDER.indexOf(requested);
    const providerIndex = Math.ceil(
        requestedIndex * (enabledAscending.length - 1) / (VERA_ORDER.length - 1),
    );
    const providerEffort = enabledAscending[providerIndex];
    if (providerEffort === undefined) {
        throw new Error(`OpenRouter model ${model} has invalid reasoning metadata`);
    }
    return { requested, providerEffort, inferred: true };
}

async function loadOpenRouterEfforts(
    model: string,
    fetchRequest: FetchRequest,
): Promise<readonly string[]> {
    if (fetchRequest !== globalThis.fetch) {
        return fetchOpenRouterEfforts(model, fetchRequest);
    }

    let request = openRouterEffortRequests.get(model);
    if (request === undefined) {
        request = fetchOpenRouterEfforts(model, fetchRequest);
        openRouterEffortRequests.set(model, request);
    }
    try {
        return await request;
    } catch (error) {
        openRouterEffortRequests.delete(model);
        throw error;
    }
}

async function fetchOpenRouterEfforts(
    model: string,
    fetchRequest: FetchRequest,
): Promise<readonly string[]> {
    const response = await fetchRequest("https://openrouter.ai/api/v1/models");
    if (!response.ok) {
        throw new Error(
            `OpenRouter model metadata request failed (${response.status})`,
        );
    }

    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null) {
        throw new Error("OpenRouter model metadata returned an invalid response");
    }
    const data = (value as Record<string, unknown>).data;
    if (!Array.isArray(data)) {
        throw new Error("OpenRouter model metadata omitted its model list");
    }

    const entry = data.find((candidate) => (
        typeof candidate === "object"
        && candidate !== null
        && (candidate as Record<string, unknown>).id === model
    ));
    const reasoning = entry === undefined
        ? undefined
        : (entry as Record<string, unknown>).reasoning;
    const supportedEfforts = typeof reasoning === "object" && reasoning !== null
        ? (reasoning as Record<string, unknown>).supported_efforts
        : undefined;
    if (!Array.isArray(supportedEfforts)) {
        throw new Error(
            `OpenRouter model ${model} does not expose reasoning effort metadata`,
        );
    }
    return uniqueNonEmptyStrings(supportedEfforts);
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
    return [...new Set(values.filter((value): value is string => (
        typeof value === "string" && value.length > 0
    )))];
}
