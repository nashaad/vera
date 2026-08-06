import type {
    EffortSubstitutedEvent,
    ModelReasoningEffort,
} from "./types.ts";
import { verifiedModel } from "./supported-models.ts";

export type ReasoningProvider = "openrouter" | "openai-codex";
export type ProviderReasoningEffort = string;

export interface ReasoningSelection {
    readonly requested: ModelReasoningEffort;
    // Absent means the model has no known levels: the turn runs with no
    // level specified rather than guessing one.
    readonly providerEffort?: ProviderReasoningEffort;
    readonly inferred: boolean;
}

export interface ResolveReasoningOptions {
    readonly fetch?: FetchRequest;
    // The model's own level ids, most capable first. This is the seam a
    // catalog loader (any provider) plugs a level list into without this
    // module needing to know how that list was read.
    readonly supportedEfforts?: readonly string[];
    // The model's own default level, used when the requested level is not
    // one of its own. Matches `CatalogModel.default_level`.
    readonly defaultLevel?: string;
}

export interface FetchRequest {
    (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

const openRouterEffortRequests = new Map<string, Promise<readonly string[]>>();

/**
 * Resolves what a model should actually be asked for.
 *
 * A verified catalog entry (today, OpenRouter models only) wins outright.
 * Otherwise, when the caller supplies the model's own level list through
 * `options.supportedEfforts`, that list is placed against the requested
 * level with no network call: this is the seam any future catalog loader,
 * for any provider, plugs a level list into.
 *
 * OpenRouter additionally falls back to a live discovery fetch when no
 * level list is supplied, matching its existing behaviour.
 *
 * A (provider, model) with no known level list at all is not an error: it
 * runs with no level specified, since a model can't be asked for a level it
 * has never announced.
 */
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

    return inferReasoningSelection(requested, supportedEfforts, options.defaultLevel);
}

/**
 * Places a requested level against a model's own level list. This never
 * throws: switching to a model whose vocabulary does not contain the
 * requested level degrades rather than failing the turn.
 *
 * The rule mirrors the level pane's own pre-highlight rule on purpose, so
 * resolution and what the user sees highlighted are the same sentence: the
 * requested level if it is valid for this model, else the model's own
 * default, else a moderate level, else no level specified.
 *
 * "Moderate" is deliberate and the fallback never lands on the top level.
 * A word this model does not know says nothing about how hard the user wants
 * it to think, and the cost of guessing wrong is asymmetric: silently
 * promoting an unrecognised level to maximum reasoning spends the user's
 * money and latency on an inference they never asked for. Providers
 * themselves suggest a middle setting as the default, so that is what an
 * unplaceable level settles on: a literal "medium" when the model has one,
 * otherwise the middle of its own ladder.
 *
 * Exported so the TUI's level pane can compute its pre-highlight by calling
 * this directly rather than re-implementing the placement rule a second time.
 */
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

    // "none" is a level a user chooses, never one they get handed by a
    // fallback: settling someone on no reasoning at all is as wrong a guess
    // as settling them on maximum.
    const usable = supported.filter((effort) => effort !== "none");
    if (usable.length === 0) {
        return { requested, inferred: true };
    }

    const moderate = usable.includes("medium")
        ? "medium"
        : usable[Math.floor(usable.length / 2)] as string;
    return { requested, providerEffort: moderate, inferred: true };
}

/**
 * The notice a placed selection owes the user, or undefined when the request
 * went out exactly as asked.
 *
 * Placement is the one point where a level can change without a provider ever
 * having refused anything, so it is the one point that has to say so.
 */
export function effortSubstitutionNotice(
    selection: ReasoningSelection,
): EffortSubstitutedEvent | undefined {
    if (!selection.inferred || selection.providerEffort === selection.requested) {
        return undefined;
    }
    return {
        type: "effort_substituted",
        requested: selection.requested,
        ...(selection.providerEffort === undefined
            ? {}
            : { using: selection.providerEffort }),
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
    const reasoning = entry === undefined
        ? undefined
        : (entry as Record<string, unknown>).reasoning;
    const supportedEfforts = typeof reasoning === "object" && reasoning !== null
        ? (reasoning as Record<string, unknown>).supported_efforts
        : undefined;
    // A model that announces no efforts has no reasoning control, which is a
    // fact about the model rather than a failure to look it up: most of
    // OpenRouter's list is in exactly this position. It runs with no level
    // specified. Only the lookup itself failing is an error, and those throw
    // above.
    return Array.isArray(supportedEfforts)
        ? uniqueNonEmptyStrings(supportedEfforts)
        : [];
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
    return [...new Set(values.filter((value): value is string => (
        typeof value === "string" && value.length > 0
    )))];
}
