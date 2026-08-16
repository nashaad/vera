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
 * Slots come in two kinds. Intent slots name how a job should feel, and any
 * caller may reach for one. Job slots name a single feature, and exist so that
 * feature can be pointed somewhere without disturbing every other caller that
 * shares its intent. A job slot falls back to its intent slot, so the list a
 * user meets is three rows long and the job rows only matter to someone who
 * wants them.
 *
 * Slots are sparse. An unbound slot is the normal state, not a broken one.
 * What happens next is the caller's to declare: work that must happen falls
 * through to the session's own model, and work that need not happen does not.
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
export type IntentSlotId = "snappy" | "eco" | "extra";

export type JobSlotId = "reviewer" | "compaction";

export type ModelSlotId = IntentSlotId | JobSlotId;

export const INTENT_SLOT_IDS: readonly IntentSlotId[] = [
    "snappy",
    "eco",
    "extra",
];

export const JOB_SLOT_IDS: readonly JobSlotId[] = ["reviewer", "compaction"];

export const MODEL_SLOT_IDS: readonly ModelSlotId[] = [
    ...INTENT_SLOT_IDS,
    ...JOB_SLOT_IDS,
];

/**
 * The intent a job slot draws on when it is unbound, which is its usual state.
 */
export const JOB_SLOT_INTENTS: Readonly<Record<JobSlotId, IntentSlotId>> = {
    reviewer: "extra",
    compaction: "eco",
};

/** Shipped words, used when a slot declares no label of its own. */
export const DEFAULT_SLOT_LABELS: Readonly<Record<ModelSlotId, string>> = {
    snappy: "snappy",
    eco: "eco",
    extra: "extra",
    reviewer: "reviewer",
    compaction: "compaction",
};

/**
 * What each slot is for, in the terms a user picks a model by. Held here so
 * the picker and the docs say the same thing.
 */
export const MODEL_SLOT_INTENTS: Readonly<Record<ModelSlotId, string>> = {
    snappy: "dirt cheap and fast, for work nothing depends on",
    eco: "smart but fast, for work a turn waits on",
    extra: "the most capable model, for work worth waiting for",
    reviewer: "reviewing a change",
    compaction: "summarising a session that has run long",
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

export function isJobSlotId(value: unknown): value is JobSlotId {
    return typeof value === "string"
        && (JOB_SLOT_IDS as readonly string[]).includes(value);
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

export type SlotBindingSource =
    | "explicit"
    | "slot"
    | "intent"
    | "session"
    | "none";

export interface SlotBinding {
    readonly source: SlotBindingSource;
    /** What will run. Empty when the caller falls through to the session. */
    readonly models: readonly VeraCatalogModel[];
    /**
     * What the winning rung named, before reachability narrowed it. Equal to
     * `models` when everything named could be reached, and longer when some
     * entries were skipped, which is what lets a screen say that a setting is
     * being honored only in part.
     */
    readonly declared: readonly VeraCatalogModel[];
}

/**
 * Whether an entry can be reached right now.
 *
 * The pool answers this, and it is passed in rather than imported so that
 * config keeps knowing nothing about pool state. Omitted means unasked, in
 * which case every declared entry is treated as reachable.
 */
export type ReachabilityCheck = (entry: VeraCatalogModel) => boolean;

/**
 * Which models answer a caller, and on whose say-so.
 *
 * A route is exhausted before the next rung is tried: an unreachable first
 * entry falls to the second entry of the same route, and only a route with
 * nothing reachable in it climbs. A route is the user saying "these, in this
 * order", so we owe them all of it before substituting something they did not
 * pick.
 *
 * Reachability is read once, here. A provider that recovers a moment later
 * does not change a binding that has already resolved.
 *
 * A job slot that is unbound draws on its intent slot before giving up.
 * `session` means nothing was bound anywhere and the caller is required, so it
 * runs on whatever model the session is already using. `none` means nothing
 * was bound and the caller is optional, so it does not run.
 */
export function bindModelSlot(
    catalog: VeraModelCatalogConfig,
    slots: VeraModelSlotsConfig,
    request: SlotBindingRequest,
    isReachable?: ReachabilityCheck,
): SlotBinding {
    const rung = (
        source: SlotBindingSource,
        declared: readonly VeraCatalogModel[] | undefined,
    ): SlotBinding | undefined => {
        if (declared === undefined || declared.length === 0) return undefined;
        const models = isReachable === undefined
            ? declared
            : declared.filter((entry) => isReachable(entry));
        return models.length === 0 ? undefined : { source, models, declared };
    };

    const explicit = request.explicitRoute === undefined
        ? undefined
        : rung("explicit", resolveModelRoute(catalog, request.explicitRoute));
    if (explicit !== undefined) return explicit;

    const bound = rung(
        "slot",
        resolveModelSlot(catalog, slots, request.slot)?.models,
    );
    if (bound !== undefined) return bound;

    if (isJobSlotId(request.slot)) {
        const intent = rung(
            "intent",
            resolveModelSlot(catalog, slots, JOB_SLOT_INTENTS[request.slot])
                ?.models,
        );
        if (intent !== undefined) return intent;
    }
    return request.demand === "required"
        ? { source: "session", models: [], declared: [] }
        : { source: "none", models: [], declared: [] };
}

/**
 * A model or provider that automatic slot assignment never reaches for.
 *
 * `provider` alone excludes every model that provider serves, `model` alone
 * excludes that model wherever it is served, and both together excludes one
 * model at one provider. Exclusion applies only to automatic assignment: a
 * slot the user binds by hand holds whatever they bound, including these.
 */
export interface SlotAutoExclusion {
    readonly provider?: string;
    readonly model?: string;
}

export const DEFAULT_SLOT_AUTO_EXCLUSIONS: readonly SlotAutoExclusion[] = [
    { provider: "cerebras" },
    { model: "anthropic/claude-fable-5" },
];

export function isAutoAssignable(
    entry: VeraCatalogModel,
    exclusions: readonly SlotAutoExclusion[] = DEFAULT_SLOT_AUTO_EXCLUSIONS,
): boolean {
    return !exclusions.some((excluded) => {
        if (excluded.provider === undefined && excluded.model === undefined) {
            return false;
        }
        return (excluded.provider === undefined
            || excluded.provider === entry.provider)
            && (excluded.model === undefined || excluded.model === entry.model);
    });
}
