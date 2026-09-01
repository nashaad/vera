
import {
    parseCatalogModel,
    resolveModelRoute,
    type VeraCatalogModel,
    type VeraModelCatalogConfig,
} from "./model-catalog.ts";

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

export const JOB_ASSIGNMENT_INTENTS: Readonly<
    Partial<Record<JobAssignmentId, IntentAssignmentId>>
> = {
    reviewer: "extra",
    compaction: "eco",
};

export const DEFAULT_ASSIGNMENT_LABELS: Readonly<Record<ModelAssignmentId, string>> = {
    snappy: "snappy",
    eco: "eco",
    extra: "extra",
    reviewer: "classifier",
    compaction: "compaction",
    subagents: "subagents",
};

export const MODEL_ASSIGNMENT_INTENTS: Readonly<Record<ModelAssignmentId, string>> = {
    snappy: "dirt cheap and fast, for work nothing depends on",
    eco: "smart but fast, for work a turn waits on",
    extra: "the most capable model, for work worth waiting for",
    reviewer: "classifying whether an action may run",
    compaction: "summarising a session that has run long",
    subagents: "delegated work, in fallback order",
};

export interface VeraModelAssignmentConfig {
    readonly model_route?: string;
    readonly models?: readonly VeraCatalogModel[];
    readonly label?: string;
    readonly allow_self?: boolean;
}

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
    readonly models: readonly VeraCatalogModel[];
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
    readonly models: readonly VeraCatalogModel[];
    readonly declared: readonly VeraCatalogModel[];
}

export type ReachabilityCheck = (entry: VeraCatalogModel) => boolean;

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

export interface AssignmentAutoExclusion {
    readonly provider?: string;
    readonly model?: string;
}

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

export interface ModelAssignmentRow {
    readonly assignment: ModelAssignmentId;
    readonly label: string;
    readonly intent: string;
    readonly bound: boolean;
    readonly route?: string;
    readonly declared: readonly VeraCatalogModel[];
    readonly models: readonly VeraCatalogModel[];
    readonly source: AssignmentBindingSource;
    readonly inherits?: IntentAssignmentId;
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
