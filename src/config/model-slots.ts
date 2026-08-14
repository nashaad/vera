/**
 * The named bindings a caller reaches for instead of naming a model.
 *
 * A slot binds a job's intent to a route, and a route is an ordered list of
 * catalog entries. A catalog entry carries a reasoning effort as well as a
 * model, which is what makes a slot able to say something a model alone
 * cannot: the same model at two efforts is two different answers on both cost
 * and speed, and a big model told not to think can come back sooner and
 * cheaper than a small one told to think hard.
 *
 * The set is deliberately small and fixed. Naming slots per job instead would
 * mean every new feature invented one and asked the user to fill it in, so
 * these three are the whole vocabulary and a feature picks one.
 *
 * Slots are sparse. An unbound slot is the normal state, not a broken one, and
 * a caller that finds nothing bound does not run. That is the safe direction:
 * the cost of guessing a model for throwaway work is money spent quietly.
 */

import {
    resolveModelRoute,
    type VeraCatalogModel,
    type VeraModelCatalogConfig,
} from "./model-catalog.ts";

/**
 * Ids are fixed because callers compile against them. The word the user sees
 * is `label`, which they may change without breaking anything.
 */
export type ModelSlotId = "snappy" | "eco" | "extra";

export const MODEL_SLOT_IDS: readonly ModelSlotId[] = [
    "snappy",
    "eco",
    "extra",
];

/** Shipped words, used when a slot declares no label of its own. */
export const DEFAULT_SLOT_LABELS: Readonly<Record<ModelSlotId, string>> = {
    snappy: "snappy",
    eco: "eco",
    extra: "extra",
};

/**
 * What each slot is for, in the terms a user picks a model by. Held here so
 * the picker and the docs say the same thing.
 */
export const MODEL_SLOT_INTENTS: Readonly<Record<ModelSlotId, string>> = {
    snappy: "dirt cheap and fast, for work nothing depends on",
    eco: "smart but fast, for work a turn waits on",
    extra: "the most capable model, for work worth waiting for",
};

export interface VeraModelSlotConfig {
    readonly model_route: string;
    /** The user's own word for this slot. Display only. */
    readonly label?: string;
}

export type VeraModelSlotsConfig = Readonly<
    Partial<Record<ModelSlotId, VeraModelSlotConfig>>
>;

export interface ResolvedModelSlot {
    readonly slot: ModelSlotId;
    readonly label: string;
    /** In preference order, each carrying its own reasoning effort. */
    readonly models: readonly VeraCatalogModel[];
    /** The route this slot came from. Diagnostic only. */
    readonly route: string;
}

export function isModelSlotId(value: unknown): value is ModelSlotId {
    return typeof value === "string"
        && (MODEL_SLOT_IDS as readonly string[]).includes(value);
}

export function slotLabel(
    slots: VeraModelSlotsConfig,
    slot: ModelSlotId,
): string {
    const declared = slots[slot]?.label;
    return declared === undefined || declared.trim().length === 0
        ? DEFAULT_SLOT_LABELS[slot]
        : declared;
}

export function parseModelSlotsConfig(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): VeraModelSlotsConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const slots: Partial<Record<ModelSlotId, VeraModelSlotConfig>> = {};
    for (const [name, entry] of Object.entries(value)) {
        if (!isModelSlotId(name)) {
            return undefined;
        }
        const parsed = parseSlot(entry, routes);
        if (parsed === undefined) {
            return undefined;
        }
        slots[name] = parsed;
    }
    return slots;
}

function parseSlot(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): VeraModelSlotConfig | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const route = record.model_route;
    const label = record.label;
    if (
        typeof route !== "string"
        || routes[route] === undefined
        || (label !== undefined
            && (typeof label !== "string" || label.trim().length === 0))
    ) {
        return undefined;
    }
    return {
        model_route: route,
        ...(label === undefined ? {} : { label: label.trim() }),
    };
}

/**
 * A slot resolved to the catalog entries that answer it, in preference order,
 * or undefined when the slot is unbound or names a route the catalog no longer
 * satisfies. Undefined is the caller's cue not to run.
 */
export function resolveModelSlot(
    catalog: VeraModelCatalogConfig,
    slots: VeraModelSlotsConfig,
    slot: ModelSlotId,
): ResolvedModelSlot | undefined {
    const configured = slots[slot];
    if (configured === undefined) {
        return undefined;
    }
    const models = resolveModelRoute(catalog, configured.model_route);
    return models === undefined ? undefined : {
        slot,
        label: slotLabel(slots, slot),
        models,
        route: configured.model_route,
    };
}

/**
 * Whether a caller can be skipped when nothing binds its slot.
 *
 * Compaction cannot: a session that does not compact reaches the context limit
 * and stops, so an unbound slot has to fall through to the session's own model
 * rather than leave the job undone. Session naming can: the session keeps its
 * plain name and nothing is lost. Getting this backwards is expensive in both
 * directions, so the caller states it rather than the resolver assuming.
 */
export type SlotDemand = "required" | "optional";

export interface SlotBindingRequest {
    readonly slot: ModelSlotId;
    readonly demand: SlotDemand;
    /**
     * A route the feature was configured with directly. The more specific
     * statement, so it wins: a user who named a route for compaction meant
     * that route, not whatever the slot happens to hold.
     */
    readonly explicitRoute?: string;
}

export type SlotBindingSource = "explicit" | "slot" | "session" | "none";

export interface SlotBinding {
    readonly source: SlotBindingSource;
    /** Empty when the caller falls through to the session's own model. */
    readonly models: readonly VeraCatalogModel[];
}

/**
 * Which models answer a caller, and on whose say-so.
 *
 * `session` means nothing was bound and the caller is required, so it runs on
 * whatever model the session is already using. `none` means nothing was bound
 * and the caller is optional, so it does not run.
 */
export function bindModelSlot(
    catalog: VeraModelCatalogConfig,
    slots: VeraModelSlotsConfig,
    request: SlotBindingRequest,
): SlotBinding {
    if (request.explicitRoute !== undefined) {
        const explicit = resolveModelRoute(catalog, request.explicitRoute);
        if (explicit !== undefined && explicit.length > 0) {
            return { source: "explicit", models: explicit };
        }
    }
    const resolved = resolveModelSlot(catalog, slots, request.slot);
    if (resolved !== undefined && resolved.models.length > 0) {
        return { source: "slot", models: resolved.models };
    }
    return request.demand === "required"
        ? { source: "session", models: [] }
        : { source: "none", models: [] };
}

/**
 * A model or provider that automatic slot assignment never reaches for.
 *
 * `provider` alone excludes every model that provider serves. `model` narrows
 * it to one. Exclusion applies only to automatic assignment: a slot the user
 * binds by hand holds whatever they bound, including these.
 */
export interface SlotAutoExclusion {
    readonly provider: string;
    readonly model?: string;
}

export const DEFAULT_SLOT_AUTO_EXCLUSIONS: readonly SlotAutoExclusion[] = [
    { provider: "cerebras" },
    { provider: "anthropic", model: "claude-fable-5" },
];

export function isAutoAssignable(
    entry: VeraCatalogModel,
    exclusions: readonly SlotAutoExclusion[] = DEFAULT_SLOT_AUTO_EXCLUSIONS,
): boolean {
    return !exclusions.some(
        (excluded) =>
            excluded.provider === entry.provider &&
            (excluded.model === undefined || excluded.model === entry.model),
    );
}
