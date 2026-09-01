import { coarsenOneStep } from "./effort-ladder.ts";
import type {
    EffortSubstitutedEvent,
    ModelReasoningEffort,
} from "./types.ts";
import { verifiedModel } from "./supported-models.ts";

export type ReasoningProvider = "openrouter" | "openai-codex";
export type ProviderReasoningEffort = string;

export interface ReasoningSelection {
    readonly requested: ModelReasoningEffort;
    readonly providerEffort?: ProviderReasoningEffort;
    readonly level?: string;
    readonly inferred: boolean;
}

export interface ResolveReasoningOptions {
    readonly fetch?: FetchRequest;
    readonly supportedEfforts?: readonly string[];
    readonly defaultLevel?: string;
    readonly providerEfforts?: Readonly<Record<string, string>>;
}

export interface FetchRequest {
    (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

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

    const supportedEfforts = options.supportedEfforts
        ?? (provider === "openrouter"
            ? await loadOpenRouterEfforts(model, options.fetch ?? globalThis.fetch)
            : undefined);

    if (supportedEfforts === undefined) {
        return { requested, inferred: false };
    }

    const efforts = options.providerEfforts;
    if (efforts !== undefined && !supportedEfforts.includes(requested)) {
        const next = coarsenOneStep(requested, efforts);
        if (next !== undefined) {
            return {
                requested,
                providerEffort: next.providerEffort,
                ...(next.level === next.providerEffort
                    ? {}
                    : { level: next.level }),
                inferred: true,
            };
        }
    }

    const selection = inferReasoningSelection(
        requested,
        supportedEfforts,
        options.defaultLevel,
    );
    return onWire(selection, options.providerEfforts);
}

function onWire(
    selection: ReasoningSelection,
    providerEfforts: Readonly<Record<string, string>> | undefined,
): ReasoningSelection {
    const wire = selection.providerEffort === undefined
        ? undefined
        : providerEfforts?.[selection.providerEffort];
    return wire === undefined || wire === selection.providerEffort
        ? selection
        : {
            ...selection,
            providerEffort: wire,
            level: selection.providerEffort as string,
        };
}

export function inferReasoningSelection(
    requested: ModelReasoningEffort,
    supportedDescending: readonly string[],
    defaultLevel?: string,
): ReasoningSelection {
    const supported = uniqueNonEmptyStrings(supportedDescending);

    if (supported.includes(requested)) {
        return { requested, providerEffort: requested, inferred: true };
    }

    if (defaultLevel !== undefined && supported.includes(defaultLevel)) {
        return { requested, providerEffort: defaultLevel, inferred: true };
    }

    const usable = supported.filter((effort) => effort !== "none");
    if (usable.length === 0) {
        return { requested, inferred: true };
    }

    const moderate = usable.includes("medium")
        ? "medium"
        : usable[Math.floor(usable.length / 2)] as string;
    return { requested, providerEffort: moderate, inferred: true };
}

export function effortSubstitutionNotice(
    selection: ReasoningSelection,
): EffortSubstitutedEvent | undefined {
    const using = selection.level ?? selection.providerEffort;
    if (!selection.inferred || using === selection.requested) {
        return undefined;
    }
    return {
        type: "effort_substituted",
        requested: selection.requested,
        ...(using === undefined ? {} : { using }),
        reason: `the model does not offer effort "${selection.requested}"`,
    };
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
    const record = entry === undefined
        ? undefined
        : entry as Record<string, unknown>;
    const reasoning = record?.reasoning;
    const supportedEfforts = typeof reasoning === "object" && reasoning !== null
        ? (reasoning as Record<string, unknown>).supported_efforts
        : undefined;
    if (Array.isArray(supportedEfforts)) {
        return uniqueNonEmptyStrings(supportedEfforts);
    }
    const parameters = Array.isArray(record?.supported_parameters)
        ? uniqueNonEmptyStrings(record.supported_parameters)
        : [];
    if (
        parameters.includes("reasoning")
        || parameters.includes("reasoning_effort")
    ) {
        return ["high", "medium", "low"];
    }
    return [];
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
    return [...new Set(values.filter((value): value is string => (
        typeof value === "string" && value.length > 0
    )))];
}
