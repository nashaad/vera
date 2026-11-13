import { join } from "node:path";

import { createLastGoodVeraConfigReader, lastGoodConfigNotice, type LastGoodVeraConfig } from "../../../src/config.ts";
import type { ModelAssignmentRow } from "../../../src/config/model-assignments.ts";
import type { VeraCatalogModel } from "../../../src/config/model-catalog.ts";
import {
    addedModel,
    assignModelToAll,
    assignmentRefusal,
    assignmentRows,
    modelRefusal,
    needsFavorite,
    writeAssignmentEdit,
    type AssignmentEdit,
    type AssignmentFiles,
} from "../../../src/model/assignment-edits.ts";
import {
    ASSIGNMENT_IDS,
    type AssignAllResult,
    type AssignedModel,
    type AssignmentId,
    type AssignmentSlot,
    type AssignmentsResult,
    type AssignmentsView,
    type AssignmentWriteResult,
} from "../../ui/src/protocol/assignments.ts";
import { modelArgument, providerArgument } from "./model-requests.ts";

type Fields = Record<string, unknown>;

const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

// Reads and writes the home's config.json by path, so the folder the app was started from never matters.
export class AssignmentStore {
    private readonly files: AssignmentFiles;
    private readonly readConfig: () => LastGoodVeraConfig;

    constructor(home: string) {
        const configPath = join(home, "config.json");
        this.files = { configPath };
        this.readConfig = createLastGoodVeraConfigReader({ path: configPath });
    }

    read(): AssignmentsResult {
        try {
            return this.view(this.readConfig());
        } catch (error) {
            return { ok: false, reason: reasonOf(error) };
        }
    }

    edit(edit: AssignmentEdit): AssignmentWriteResult {
        try {
            const refusal = assignmentRefusal(edit, this.files);
            if (refusal !== undefined) return { ok: false, reason: refusal };
            writeAssignmentEdit(edit, this.rows(), this.files);
            const added = addedModel(edit);
            return {
                ok: true,
                view: this.view(this.readConfig()),
                favorite: added !== undefined && needsFavorite(added.provider, added.model, this.files),
            };
        } catch (error) {
            return { ok: false, reason: reasonOf(error) };
        }
    }

    assignAll(provider: string, model: string): AssignAllResult {
        try {
            const refusal = modelRefusal(provider, model, this.files);
            if (refusal !== undefined) return { ok: false, reason: refusal };
            const result = assignModelToAll(provider, model, this.rows(), this.files);
            if (result.assigned.length === 0 && result.failure !== undefined) return { ok: false, reason: result.failure };
            return {
                ok: true,
                view: this.view(this.readConfig()),
                favorite: needsFavorite(provider, model, this.files),
                assigned: result.assigned,
                ...(result.failure === undefined ? {} : { failure: result.failure }),
            };
        } catch (error) {
            return { ok: false, reason: reasonOf(error) };
        }
    }

    private rows(): readonly ModelAssignmentRow[] {
        return assignmentRows(this.readConfig().config, this.files);
    }

    private view(read: LastGoodVeraConfig): AssignmentsView {
        const notice = lastGoodConfigNotice(read);
        return {
            ok: true,
            slots: assignmentRows(read.config, this.files).map(slotOf),
            ...(notice === undefined ? {} : { notice }),
        };
    }
}

// A change from the window, or undefined when it is not one this assignment takes.
export function changeArgument(value: unknown): AssignmentEdit | undefined {
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
        ...(effort === undefined || effort === null ? {} : { reasoningEffort: effort }),
        ...(remove === undefined || remove === null ? {} : { remove }),
        ...(allowSelf === undefined || allowSelf === null ? {} : { allowSelf }),
        ...(failsafe === undefined || failsafe === null ? {} : { failsafe }),
        ...(move === undefined || move === null ? {} : { move }),
    };
}

function slotOf(row: ModelAssignmentRow): AssignmentSlot {
    return {
        id: row.assignment as AssignmentId,
        label: row.label,
        bound: row.bound,
        ...(row.route === undefined ? {} : { route: row.route }),
        declared: row.declared.map(assignedOf),
        running: row.models.map(assignedOf),
        source: row.source,
        ...(row.inherits === undefined ? {} : { inherits: row.inherits }),
        ...(row.allowSelf === undefined ? {} : { allowSelf: row.allowSelf }),
    };
}

function assignedOf(entry: VeraCatalogModel): AssignedModel {
    return {
        provider: entry.provider,
        model: entry.model,
        ...(entry.reasoning_effort === undefined ? {} : { effort: entry.reasoning_effort }),
    };
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

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
