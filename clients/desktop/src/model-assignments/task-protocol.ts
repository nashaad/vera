import type { LastGoodConfigFile } from "../../../../src/config.ts";
import type { AssignmentEdit } from "../../../../src/model/assignment-edits.ts";
import {
    ASSIGNMENT_IDS,
    type AssignAllResult,
    type AssignedModel,
    type AssignmentChange,
    type AssignmentSlot,
    type AssignmentsFailure,
    type AssignmentsResult,
    type AssignmentsView,
    type AssignmentWriteResult,
    type TierId,
    TIER_IDS,
} from "../../../ui/src/protocol/assignments.ts";
import { modelArgument, providerArgument } from "../model-arguments.ts";

// The main process imports only this file from this folder; the rest loads the config code, which runs in the task process.

export const ASSIGNMENT_TASK_SERVICE = "Vera Model Assignments";
export const ASSIGNMENT_TASK_FILE = "model-assignments.cjs";

// lastGood is the config the previous task last loaded; the task falls back to it when config.json stops loading.
interface TaskBase {
    readonly home: string;
    readonly lastGood?: LastGoodConfigFile;
}

export type AssignmentTask =
    | (TaskBase & { readonly kind: "read" })
    | (TaskBase & { readonly kind: "edit"; readonly change: AssignmentChange })
    | (TaskBase & { readonly kind: "assign-all"; readonly provider: string; readonly model: string });

interface ReplyBase {
    readonly lastGood?: LastGoodConfigFile;
}

export type AssignmentTaskReply =
    | (ReplyBase & { readonly kind: "read"; readonly result: AssignmentsResult })
    | (ReplyBase & { readonly kind: "edit"; readonly result: AssignmentWriteResult })
    | (ReplyBase & { readonly kind: "assign-all"; readonly result: AssignAllResult });

type Fields = Record<string, unknown>;

const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SOURCES: readonly AssignmentSlot["source"][] = ["assignment", "intent", "session"];

// A change from the window, or undefined when it is not one this assignment takes.
export function changeArgument(value: unknown): AssignmentChange | undefined {
    if (!isFields(value)) return undefined;
    const assignment = ASSIGNMENT_IDS.find((id) => id === value.assignment);
    if (assignment === undefined) return undefined;
    const provider = optional(value.provider, providerArgument);
    const model = optional(value.model, modelArgument);
    const effort = optional(value.effort, (text) => (typeof text === "string" && EFFORT_PATTERN.test(text) ? text : undefined));
    const remove = optional(value.remove, flag);
    const allowSelf = optional(value.allowSelf, flag);
    const failsafe = optional(value.failsafe, flag);
    const move = optional(value.move, (step) => (step === -1 || step === 1 ? step : undefined));
    if ([provider, model, effort, remove, allowSelf, failsafe, move].includes(null)) return undefined;
    if ((model === undefined) !== (provider === undefined)) return undefined;
    if (assignment !== "subagents" && (remove !== undefined || allowSelf !== undefined || move !== undefined)) return undefined;
    if (assignment !== "reviewer" && failsafe !== undefined) return undefined;
    if ((remove === true || move !== undefined) && model === undefined) return undefined;
    return {
        assignment,
        ...(provider === undefined || provider === null ? {} : { provider }),
        ...(model === undefined || model === null ? {} : { model }),
        ...(effort === undefined || effort === null ? {} : { effort }),
        ...(remove === undefined || remove === null ? {} : { remove }),
        ...(allowSelf === undefined || allowSelf === null ? {} : { allowSelf }),
        ...(failsafe === undefined || failsafe === null ? {} : { failsafe }),
        ...(move === undefined || move === null ? {} : { move }),
    };
}

export function editOf(change: AssignmentChange): AssignmentEdit {
    const { effort, ...rest } = change;
    return effort === undefined ? rest : { ...rest, reasoningEffort: effort };
}

export function parseAssignmentTask(value: unknown): AssignmentTask | undefined {
    if (!isFields(value) || typeof value.home !== "string") return undefined;
    const lastGood = lastGoodOf(value.lastGood);
    if (lastGood === null) return undefined;
    const base: TaskBase = { home: value.home, ...(lastGood === undefined ? {} : { lastGood }) };
    if (value.kind === "read") return { ...base, kind: "read" };
    if (value.kind === "edit") {
        const change = changeArgument(value.change);
        return change === undefined ? undefined : { ...base, kind: "edit", change };
    }
    if (value.kind === "assign-all") {
        const provider = providerArgument(value.provider);
        const model = modelArgument(value.model);
        return provider === undefined || model === undefined ? undefined : { ...base, kind: "assign-all", provider, model };
    }
    return undefined;
}

export function parseAssignmentTaskReply(value: unknown): AssignmentTaskReply | undefined {
    if (!isFields(value)) return undefined;
    const lastGood = lastGoodOf(value.lastGood);
    if (lastGood === null) return undefined;
    const base: ReplyBase = lastGood === undefined ? {} : { lastGood };
    if (value.kind === "read") {
        const result = failureOf(value.result) ?? viewOf(value.result);
        return result === undefined ? undefined : { ...base, kind: "read", result };
    }
    if (value.kind === "edit") {
        const result = failureOf(value.result) ?? writtenOf(value.result);
        return result === undefined ? undefined : { ...base, kind: "edit", result };
    }
    if (value.kind === "assign-all") {
        const result = failureOf(value.result) ?? assignedToAllOf(value.result);
        return result === undefined ? undefined : { ...base, kind: "assign-all", result };
    }
    return undefined;
}

// The config itself is only carried between tasks, never read on this side; undefined when absent, null when malformed.
function lastGoodOf(value: unknown): LastGoodConfigFile | undefined | null {
    if (value === undefined) return undefined;
    if (!isFields(value) || typeof value.path !== "string" || !isFields(value.config)) return null;
    return value as unknown as LastGoodConfigFile;
}

function failureOf(value: unknown): AssignmentsFailure | undefined {
    return isFields(value) && value.ok === false && typeof value.reason === "string" ? { ok: false, reason: value.reason } : undefined;
}

function writtenOf(value: unknown): AssignmentWriteResult | undefined {
    if (!isFields(value) || value.ok !== true || typeof value.favorite !== "boolean") return undefined;
    const view = viewOf(value.view);
    return view === undefined ? undefined : { ok: true, view, favorite: value.favorite };
}

function assignedToAllOf(value: unknown): AssignAllResult | undefined {
    if (!isFields(value) || value.ok !== true || typeof value.favorite !== "boolean") return undefined;
    const view = viewOf(value.view);
    const assigned = strings(value.assigned);
    if (view === undefined || assigned === undefined) return undefined;
    if (value.failure !== undefined && typeof value.failure !== "string") return undefined;
    return {
        ok: true,
        view,
        favorite: value.favorite,
        assigned,
        ...(value.failure === undefined ? {} : { failure: value.failure }),
    };
}

function viewOf(value: unknown): AssignmentsView | undefined {
    if (!isFields(value) || value.ok !== true || !Array.isArray(value.slots)) return undefined;
    if (value.notice !== undefined && typeof value.notice !== "string") return undefined;
    const slots = every(value.slots, slotOf);
    if (slots === undefined) return undefined;
    return { ok: true, slots, ...(value.notice === undefined ? {} : { notice: value.notice }) };
}

function slotOf(value: unknown): AssignmentSlot | undefined {
    if (!isFields(value)) return undefined;
    const id = ASSIGNMENT_IDS.find((candidate) => candidate === value.id);
    const source = SOURCES.find((candidate) => candidate === value.source);
    const declared = every(value.declared, modelOf);
    const running = every(value.running, modelOf);
    if (id === undefined || source === undefined || declared === undefined || running === undefined) return undefined;
    if (typeof value.label !== "string" || typeof value.bound !== "boolean") return undefined;
    if (value.route !== undefined && typeof value.route !== "string") return undefined;
    if (value.allowSelf !== undefined && typeof value.allowSelf !== "boolean") return undefined;
    const inherits = value.inherits === undefined ? undefined : TIER_IDS.find((tier): tier is TierId => tier === value.inherits);
    if (value.inherits !== undefined && inherits === undefined) return undefined;
    return {
        id,
        label: value.label,
        bound: value.bound,
        ...(value.route === undefined ? {} : { route: value.route }),
        declared,
        running,
        source,
        ...(inherits === undefined ? {} : { inherits }),
        ...(value.allowSelf === undefined ? {} : { allowSelf: value.allowSelf }),
    };
}

function modelOf(value: unknown): AssignedModel | undefined {
    if (!isFields(value) || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
    if (value.effort !== undefined && typeof value.effort !== "string") return undefined;
    return { provider: value.provider, model: value.model, ...(value.effort === undefined ? {} : { effort: value.effort }) };
}

function every<T>(value: unknown, parse: (entry: unknown) => T | undefined): T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const parsed: T[] = [];
    for (const entry of value) {
        const item = parse(entry);
        if (item === undefined) return undefined;
        parsed.push(item);
    }
    return parsed;
}

function strings(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

// undefined when the field is absent, null when it is present but not valid.
function optional<T>(value: unknown, parse: (value: unknown) => T | undefined): T | undefined | null {
    if (value === undefined) return undefined;
    return parse(value) ?? null;
}

function flag(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
