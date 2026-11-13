import { join } from "node:path";

import { lastGoodConfigNotice, readVeraConfigOverLastGood, type LastGoodConfigFile, type LastGoodVeraConfig } from "../../../../src/config.ts";
import type { ModelAssignmentRow } from "../../../../src/config/model-assignments.ts";
import type { VeraCatalogModel } from "../../../../src/config/model-catalog.ts";
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
} from "../../../../src/model/assignment-edits.ts";
import type {
    AssignAllResult,
    AssignedModel,
    AssignmentId,
    AssignmentSlot,
    AssignmentsResult,
    AssignmentsView,
    AssignmentWriteResult,
} from "../../../ui/src/protocol/assignments.ts";

// Reads and writes the home's config.json by path, so the folder the app was started from never matters.
export class AssignmentStore {
    private readonly files: AssignmentFiles;
    private readonly configPath: string;

    constructor(home: string, private kept: LastGoodConfigFile | undefined = undefined) {
        this.configPath = join(home, "config.json");
        this.files = { configPath: this.configPath };
    }

    // The config the last read loaded, or the one it fell back to.
    get lastGood(): LastGoodConfigFile | undefined {
        return this.kept;
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

    private readConfig(): LastGoodVeraConfig {
        const next = readVeraConfigOverLastGood({ path: this.configPath }, this.kept);
        this.kept = next.lastGood;
        return next.read;
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

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
