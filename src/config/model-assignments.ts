/**
 * The named bindings a caller reaches for instead of naming a model.
 *
 * A assignment binds a job's intent to a route, and a route is an ordered list of
 * catalog entries. A catalog entry carries a reasoning effort as well as a
 * model, which is what makes a assignment able to say something a model alone
 * cannot: the same model at two efforts is two different answers on both cost
 * and speed, and a big model told not to think can come back sooner and
 * cheaper than a small one told to think hard.
 *
 * Assignments come in two kinds. Intent assignments name how a job should feel, and any
 * caller may reach for one. Job assignments name a single feature, and exist so that
 * feature can be pointed somewhere without disturbing every other caller that
 * shares its intent. A job assignment falls back to its intent assignment, so the list a
 * user meets is three rows long and the job rows only matter to someone who
 * wants them.
 *
 * Assignments are sparse. An unbound assignment is the normal state, not a broken one.
 * What happens next is the caller's to declare: work that must happen falls
 * through to the session's own model, and work that need not happen does not.
 */

import {
    parseCatalogModel,
    resolveModelRoute,
    type VeraCatalogModel,
    type VeraModelCatalogConfig,
} from "./model-catalog.ts";

/**
 * Ids are fixed because callers compile against them. The word the user sees
 * is `label`, which they may change without breaking anything.
 */
export type IntentAssignmentId = "snappy" | "eco" | "extra";

export type JobAssignmentId = "reviewer" | "compaction" | "subagents";

export type ModelAssignmentId = IntentAssignmentId | JobAssignmentId;

export const INTENT_ASSIGNMENT_IDS: readonly IntentAssignmentId[] = [
    "snappy",
    "eco",
    "extra",
];

export const JOB_ASSIGNMENT_IDS: readonly JobAssignmentId[] = [
    "reviewer",
    "compaction",
    "subagents",
];

export const MODEL_ASSIGNMENT_IDS: readonly ModelAssignmentId[] = [
    ...INTENT_ASSIGNMENT_IDS,
    ...JOB_ASSIGNMENT_IDS,
];

/**
 * The intent a job assignment draws on when it is unbound, which is its usual state.
 */
export const JOB_ASSIGNMENT_INTENTS: Readonly<
    Partial<Record<JobAssignmentId, IntentAssignmentId>>
> = {
    reviewer: "extra",
    compaction: "eco",
};

/** Shipped words, used when a assignment declares no label of its own. */
export const DEFAULT_ASSIGNMENT_LABELS: Readonly<Record<ModelAssignmentId, string>> = {
    snappy: "snappy",
    eco: "eco",
    extra: "extra",
    reviewer: "reviewer",
    compaction: "compaction",
    subagents: "subagents",
};

/**
 * What each assignment is for, in the terms a user picks a model by. Held here so
 * the picker and the docs say the same thing.
 */
export const MODEL_ASSIGNMENT_INTENTS: Readonly<Record<ModelAssignmentId, string>> = {
    snappy: "dirt cheap and fast, for work nothing depends on",
    eco: "smart but fast, for work a turn waits on",
    extra: "the most capable model, for work worth waiting for",
    reviewer: "reviewing a change",
    compaction: "summarising a session that has run long",
    subagents: "delegated work, in fallback order",
};

/**
 * What a assignment is bound to. Exactly one of the two ways of saying it: a named
 * route from the catalog, or models written on the assignment itself. Both at once
 * is refused rather than ranked, because a file carrying two answers has no
 * obvious right one and the user would have to guess which they were editing.
 *
 * Inline models exist because the picker binds a assignment to a model the user just
 * chose. Making that write a route would mean inventing a route name they
 * never asked for and leaving it in their file.
 */
export interface VeraModelAssignmentConfig {
    readonly model_route?: string;
    /** In preference order, each carrying its own reasoning effort. */
    readonly models?: readonly VeraCatalogModel[];
    /** The user's own word for this assignment. Display only. */
    readonly label?: string;
    /** Only meaningful for `subagents`; absent is the fail-closed default. */
    readonly allow_self?: boolean;
}

/**
 * Exclusions a user wrote, per assignment. A list merges with the shipped default
 * for that assignment, so adding one rule does not silently drop the others. An
 * empty list clears a assignment's exclusions entirely, which is the way back to
 * none.
 */
export type SlotExclusionsConfig = Readonly<
    Partial<Record<ModelAssignmentId, readonly AssignmentAutoExclusion[]>>
>;

export type VeraModelAssignmentsConfig = Readonly<
    & Partial<Record<ModelAssignmentId, VeraModelAssignmentConfig>>
    & { never_auto?: SlotExclusionsConfig }
>;

export interface ResolvedModelAssignment {
    readonly assignment: ModelAssignmentId;
    readonly label: string;
    /** In preference order, each carrying its own reasoning effort. */
    readonly models: readonly VeraCatalogModel[];
    /** The route this assignment named, absent when its models are inline. */
    readonly route?: string;
}

export function isModelSlotId(value: unknown): value is ModelAssignmentId {
    return typeof value === "string"
        && (MODEL_ASSIGNMENT_IDS as readonly string[]).includes(value);
}

export function isJobAssignmentId(value: unknown): value is JobAssignmentId {
    return typeof value === "string"
        && (JOB_ASSIGNMENT_IDS as readonly string[]).includes(value);
}

export function assignmentLabel(
    assignments: VeraModelAssignmentsConfig,
    assignment: ModelAssignmentId,
): string {
    const declared = assignments[assignment]?.label;
    return declared === undefined || declared.trim().length === 0
        ? DEFAULT_ASSIGNMENT_LABELS[assignment]
        : declared;
}

export function parseModelAssignmentsConfig(
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): VeraModelAssignmentsConfig | undefined {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const assignments: Partial<Record<ModelAssignmentId, VeraModelAssignmentConfig>>
        & { never_auto?: SlotExclusionsConfig } = {};
    for (const [name, entry] of Object.entries(value)) {
        if (name === "never_auto") {
            const exclusions = parseExclusionsConfig(entry);
            if (exclusions === undefined) {
                return undefined;
            }
            assignments.never_auto = exclusions;
            continue;
        }
        if (!isModelSlotId(name)) {
            return undefined;
        }
        const parsed = parseSlot(name, entry, routes);
        if (parsed === undefined) {
            return undefined;
        }
        assignments[name] = parsed;
    }
    return assignments;
}

function parseSlot(
    assignment: ModelAssignmentId,
    value: unknown,
    routes: Readonly<Record<string, readonly string[]>>,
): VeraModelAssignmentConfig | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const route = record.model_route;
    const inline = record.models;
    const label = record.label;
    const allowSelf = record.allow_self;
    if (
        (route !== undefined && inline !== undefined)
        || (route === undefined && inline === undefined)
        || (label !== undefined
            && (typeof label !== "string" || label.trim().length === 0))
        || (allowSelf !== undefined
            && (assignment !== "subagents" || typeof allowSelf !== "boolean"))
    ) {
        return undefined;
    }
    const additions = {
        ...(label === undefined ? {} : { label: (label as string).trim() }),
        ...(allowSelf === undefined ? {} : { allow_self: allowSelf as boolean }),
    };
    if (route !== undefined) {
        if (typeof route !== "string" || routes[route] === undefined) {
            return undefined;
        }
        return { model_route: route, ...additions };
    }
    if (
        !Array.isArray(inline)
        || (inline.length === 0
            && !(assignment === "subagents" && allowSelf === true))
    ) {
        return undefined;
    }
    const models: VeraCatalogModel[] = [];
    for (const entry of inline) {
        const model = parseCatalogModel(entry);
        if (model === undefined) {
            return undefined;
        }
        models.push(model);
    }
    return { models, ...additions };
}

/**
 * A assignment resolved to the catalog entries that answer it, in preference order,
 * or undefined when the assignment is unbound or names a route the catalog no longer
 * satisfies. Undefined is the caller's cue not to run.
 */
export function resolveModelAssignment(
    catalog: VeraModelCatalogConfig,
    assignments: VeraModelAssignmentsConfig,
    assignment: ModelAssignmentId,
): ResolvedModelAssignment | undefined {
    const configured = assignments[assignment];
    if (configured === undefined) {
        return undefined;
    }
    if (configured.models !== undefined) {
        return {
            assignment,
            label: assignmentLabel(assignments, assignment),
            models: configured.models,
        };
    }
    if (configured.model_route === undefined) {
        return undefined;
    }
    const models = resolveModelRoute(catalog, configured.model_route);
    return models === undefined ? undefined : {
        assignment,
        label: assignmentLabel(assignments, assignment),
        models,
        route: configured.model_route,
    };
}

export interface SlotBindingRequest {
    readonly assignment: ModelAssignmentId;
}

export type AssignmentBindingSource =
    | "assignment"
    | "intent"
    | "session";

export interface SlotBinding {
    readonly source: AssignmentBindingSource;
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
 * A job assignment that is unbound draws on its intent assignment first.
 * `session` means nothing was bound anywhere, so the work runs on whatever
 * model the session is already using. Nothing is ever left undone for want of
 * a binding: an unset assignment is the normal state, and the session's model
 * is always an answer.
 */
export function bindModelAssignment(
    catalog: VeraModelCatalogConfig,
    assignments: VeraModelAssignmentsConfig,
    request: SlotBindingRequest,
    isReachable?: ReachabilityCheck,
): SlotBinding {
    const rung = (
        source: AssignmentBindingSource,
        declared: readonly VeraCatalogModel[] | undefined,
    ): SlotBinding | undefined => {
        if (declared === undefined || declared.length === 0) return undefined;
        const models = isReachable === undefined
            ? declared
            : declared.filter((entry) => isReachable(entry));
        return models.length === 0 ? undefined : { source, models, declared };
    };

    const bound = rung(
        "assignment",
        resolveModelAssignment(catalog, assignments, request.assignment)?.models,
    );
    if (bound !== undefined) return bound;

    if (isJobAssignmentId(request.assignment)) {
        const intentAssignment = JOB_ASSIGNMENT_INTENTS[request.assignment];
        if (intentAssignment !== undefined) {
            const intent = rung(
                "intent",
                resolveModelAssignment(catalog, assignments, intentAssignment)?.models,
            );
            if (intent !== undefined) return intent;
        }
    }
    return { source: "session", models: [], declared: [] };
}

/**
 * A model or provider that automatic assignment assignment never reaches for.
 *
 * `provider` alone excludes every model that provider serves, `model` alone
 * excludes that model wherever it is served, and both together excludes one
 * model at one provider. Exclusion applies only to automatic assignment: a
 * assignment the user binds by hand holds whatever they bound, including these.
 */
export interface AssignmentAutoExclusion {
    readonly provider?: string;
    readonly model?: string;
}

/**
 * Per assignment, because a model that is a poor automatic choice for the most
 * capable assignment can be the right one for the cheapest. Cerebras stays eligible
 * for `snappy` on exactly that reasoning.
 */
export const DEFAULT_SLOT_AUTO_EXCLUSIONS:
    Readonly<Record<ModelAssignmentId, readonly AssignmentAutoExclusion[]>> = {
        snappy: [{ model: "anthropic/claude-fable-5" }],
        eco: [
            { model: "anthropic/claude-fable-5" },
            { provider: "cerebras" },
        ],
        extra: [
            { model: "anthropic/claude-fable-5" },
            { provider: "cerebras" },
        ],
        reviewer: [],
        compaction: [],
        subagents: [],
    };

/**
 * What actually gates automatic assignment for a assignment: the shipped default
 * plus whatever the user added. An empty user list clears the assignment.
 */
export function slotExclusions(
    assignments: VeraModelAssignmentsConfig,
    assignment: ModelAssignmentId,
): readonly AssignmentAutoExclusion[] {
    const declared = assignments.never_auto?.[assignment];
    if (declared === undefined) {
        return DEFAULT_SLOT_AUTO_EXCLUSIONS[assignment];
    }
    if (declared.length === 0) {
        return [];
    }
    return [...DEFAULT_SLOT_AUTO_EXCLUSIONS[assignment], ...declared];
}

function parseExclusionsConfig(
    value: unknown,
): SlotExclusionsConfig | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const parsed: Partial<Record<ModelAssignmentId, readonly AssignmentAutoExclusion[]>> =
        {};
    for (const [assignment, list] of Object.entries(value)) {
        if (!isModelSlotId(assignment) || !Array.isArray(list)) {
            return undefined;
        }
        const rules: AssignmentAutoExclusion[] = [];
        for (const rule of list) {
            if (
                typeof rule !== "object" || rule === null || Array.isArray(rule)
            ) {
                return undefined;
            }
            const { provider, model } = rule as Record<string, unknown>;
            if (
                (provider !== undefined && typeof provider !== "string")
                || (model !== undefined && typeof model !== "string")
                || (provider === undefined && model === undefined)
            ) {
                return undefined;
            }
            rules.push({
                ...(provider === undefined ? {} : { provider }),
                ...(model === undefined ? {} : { model }),
            });
        }
        parsed[assignment] = rules;
    }
    return parsed;
}

export function isAutoAssignable(
    entry: VeraCatalogModel,
    exclusions: readonly AssignmentAutoExclusion[],
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

/**
 * One assignment as it stands, for a surface that shows the whole set. Both what the
 * setting names and what will actually run are on the row, so a display can
 * say a route is set but unreachable rather than showing only the substitute.
 */
export interface ModelAssignmentRow {
    readonly assignment: ModelAssignmentId;
    readonly label: string;
    readonly intent: string;
    /** Whether the assignment itself names anything. */
    readonly bound: boolean;
    /** The route the user named, absent when the models are inline. */
    readonly route?: string;
    readonly declared: readonly VeraCatalogModel[];
    readonly models: readonly VeraCatalogModel[];
    readonly source: AssignmentBindingSource;
    /** The intent assignment answering this one, present only when it does. */
    readonly inherits?: IntentAssignmentId;
    /** Explicit parent-model fallback, only carried by `subagents`. */
    readonly allowSelf?: boolean;
}

export function describeModelAssignments(
    catalog: VeraModelCatalogConfig,
    assignments: VeraModelAssignmentsConfig,
    isReachable?: ReachabilityCheck,
): readonly ModelAssignmentRow[] {
    return MODEL_ASSIGNMENT_IDS.map((assignment) => {
        const resolved = resolveModelAssignment(catalog, assignments, assignment);
        const binding = bindModelAssignment(
            catalog,
            assignments,
            { assignment },
            isReachable,
        );
        return {
            assignment,
            label: assignmentLabel(assignments, assignment),
            intent: MODEL_ASSIGNMENT_INTENTS[assignment],
            bound: assignments[assignment] !== undefined,
            ...(resolved?.route === undefined ? {} : { route: resolved.route }),
            declared: resolved?.models ?? [],
            models: binding.models,
            source: binding.source,
            ...(binding.source === "intent" && isJobAssignmentId(assignment)
                ? { inherits: JOB_ASSIGNMENT_INTENTS[assignment] }
                : {}),
            ...(assignment === "subagents"
                ? { allowSelf: assignments.subagents?.allow_self === true }
                : {}),
        };
    });
}
