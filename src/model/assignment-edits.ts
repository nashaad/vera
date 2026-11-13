import { dirname, join } from "node:path";

import {
    configuredModelAssignments,
    loadOptionalVeraConfig,
    startingVeraConfig,
    updateVeraConfigDefaults,
    type VeraConfig,
    type VeraProviderId,
} from "../config.ts";
import type {
    ModelAssignmentId,
    ModelAssignmentRow,
    VeraModelAssignmentConfig,
} from "../config/model-assignments.ts";
import { derivedModelName, type VeraCatalogModel } from "../config/model-catalog.ts";
import { poolReachability } from "./assignment-reachability.ts";
import { eligibleForDefault } from "./model-operations.ts";
import { loadPoolFile, type LoadedPoolFile } from "./pool-file-loader.ts";
import { isCuratedPoolEntry } from "./pool-file.ts";
import type { ModelReasoningEffort } from "./types.ts";

// Without configPath the selected home's config.json and pool.json are used. projectRoot adds
// that folder's pool to the eligibility check; the config writer itself reads only the home pool.
export interface AssignmentFiles {
    readonly configPath?: string;
    readonly projectRoot?: string;
}

export interface AssignmentEdit {
    readonly assignment: ModelAssignmentId;
    readonly provider?: string;
    // Left out with no other flag, the assignment is unset.
    readonly model?: string;
    readonly reasoningEffort?: ModelReasoningEffort;
    // Subagents only: take the model off the list.
    readonly remove?: boolean;
    // Subagents only: empty the list and stop falling back to the spawning session's model.
    readonly clear?: boolean;
    // Subagents only: whether the spawning session's model is tried after the list.
    readonly allowSelf?: boolean;
    // Subagents only: try the model one place earlier (-1) or later (1).
    readonly move?: -1 | 1;
    // Classifier only: the model, or no model, answers when the classifier cannot.
    readonly failsafe?: boolean;
}

export interface EditedAssignment {
    // null unsets the assignment.
    readonly binding: VeraModelAssignmentConfig | null;
    readonly models: readonly VeraCatalogModel[];
    readonly allowSelf: boolean;
}

export interface AssignedToAll {
    readonly assigned: readonly string[];
    // Set when a write failed; the earlier assignments stay written.
    readonly failure?: string;
}

const NOT_VERIFIED = "Verify this model before assigning it as a default.";
const NOT_PERMITTED = "This model is not permitted by your model policy.";

export function assignmentPool(files: AssignmentFiles = {}): LoadedPoolFile {
    return loadPoolFile({
        ...(files.configPath === undefined ? {} : { userPath: join(dirname(files.configPath), "pool.json") }),
        ...(files.projectRoot === undefined ? {} : { projectRoot: files.projectRoot }),
    });
}

export function assignmentRows(config: VeraConfig | undefined, files: AssignmentFiles = {}): readonly ModelAssignmentRow[] {
    return configuredModelAssignments(config ?? startingVeraConfig(), poolReachability(assignmentPool(files).merged));
}

// The model an edit puts in place, if it puts one there.
export function addedModel(edit: AssignmentEdit): { readonly provider: string; readonly model: string } | undefined {
    if (edit.model === undefined || edit.remove === true || edit.clear === true) return undefined;
    if (edit.allowSelf !== undefined || edit.move !== undefined) return undefined;
    return { provider: edit.provider ?? "", model: edit.model };
}

export function assignmentRefusal(edit: AssignmentEdit, files: AssignmentFiles = {}): string | undefined {
    const added = addedModel(edit);
    return added === undefined ? undefined : modelRefusal(added.provider, added.model, files);
}

// Why the model may not be assigned, read from the config on disk; undefined when it may.
export function modelRefusal(provider: string, model: string, files: AssignmentFiles = {}): string | undefined {
    const config = loadOptionalVeraConfig(files.configPath === undefined ? {} : { path: files.configPath });
    const requireVerified = config?.verify_model_assignments === true;
    if (eligibleForDefault(assignmentPool(files).merged, { provider, model }, { requireVerified })) return undefined;
    return requireVerified ? NOT_VERIFIED : NOT_PERMITTED;
}

export function editedBinding(row: ModelAssignmentRow | undefined, edit: AssignmentEdit): EditedAssignment {
    const current = row?.declared ?? [];
    const selected = edit.model === undefined ? undefined : `${edit.provider ?? ""}/${edit.model}`;
    const isSelected = (entry: VeraCatalogModel): boolean => `${entry.provider}/${entry.model}` === selected;
    const chosen = edit.model === undefined ? undefined : catalogModel(edit.provider ?? "", edit.model, edit.reasoningEffort);

    if (edit.assignment === "subagents") {
        const models = edit.clear === true
            ? []
            : edit.allowSelf !== undefined
            ? [...current]
            : edit.remove === true
            ? current.filter((entry) => !isSelected(entry))
            : edit.move !== undefined
            ? moved(current, current.findIndex(isSelected), edit.move)
            : chosen === undefined
            ? [...current]
            : [...current.filter((entry) => !isSelected(entry)), chosen];
        const allowSelf = edit.allowSelf ?? (edit.clear === true ? false : row?.allowSelf === true);
        const unbinding = models.length === 0 && !allowSelf;
        return {
            binding: unbinding ? null : { models, ...(allowSelf ? { allow_self: true } : {}) },
            models,
            allowSelf,
        };
    }

    if (edit.failsafe === true) {
        const primary = edit.assignment === "reviewer" && row?.bound === true ? current[0] : undefined;
        if (primary === undefined) throw new Error("Assign the classifier before choosing its failsafe.");
        const second = chosen === undefined || isSelected(primary) ? [] : [chosen];
        const models = [primary, ...second];
        return { binding: { models }, models, allowSelf: false };
    }

    if (chosen === undefined) return { binding: null, models: [], allowSelf: false };
    // Changing the classifier keeps the failsafe it already has.
    const failsafe = edit.assignment === "reviewer" && row?.source === "assignment"
        ? current.slice(1, 2).filter((entry) => !isSelected(entry))
        : [];
    const models = [chosen, ...failsafe];
    return { binding: { models }, models, allowSelf: false };
}

// Throws when the config cannot be written or the writer refuses a model.
export function writeAssignmentEdit(
    edit: AssignmentEdit,
    rows: readonly ModelAssignmentRow[],
    files: AssignmentFiles = {},
): EditedAssignment {
    const edited = editedBinding(rows.find((entry) => entry.assignment === edit.assignment), edit);
    updateVeraConfigDefaults(
        { model_assignment: { assignment: edit.assignment, binding: edited.binding } },
        files.configPath === undefined ? {} : { path: files.configPath },
    );
    return edited;
}

// Each assignment is its own write. Subagents try the model first and keep the rest of their
// list; the classifier keeps its failsafe.
export function assignModelToAll(
    provider: string,
    model: string,
    rows: readonly ModelAssignmentRow[],
    files: AssignmentFiles = {},
): AssignedToAll {
    const ref = `${provider}/${model}`;
    const entry = catalogModel(provider, model);
    const assigned: string[] = [];
    for (const row of rows) {
        const others = row.declared.filter((declared) => `${declared.provider}/${declared.model}` !== ref);
        const models = row.assignment === "subagents"
            ? [entry, ...others]
            : row.assignment === "reviewer" && row.source === "assignment"
            ? [entry, ...row.declared.slice(1, 2).filter((declared) => `${declared.provider}/${declared.model}` !== ref)]
            : [entry];
        const allowSelf = row.assignment === "subagents" && row.allowSelf === true;
        try {
            updateVeraConfigDefaults(
                { model_assignment: { assignment: row.assignment, binding: { models, ...(allowSelf ? { allow_self: true } : {}) } } },
                files.configPath === undefined ? {} : { path: files.configPath },
            );
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const failure = assigned.length === 0
                ? `Could not write the assignment: ${reason}`
                : `Assigned ${model} to ${assigned.join(", ")}, but could not write ${row.label}: ${reason}`;
            return { assigned, failure };
        }
        assigned.push(row.label);
    }
    return { assigned };
}

// Subagents run only favorites and an agent can run on any assignment, so an assigned model
// that is not a favorite should become one.
export function needsFavorite(provider: string, model: string, files: AssignmentFiles = {}): boolean {
    const entry = assignmentPool(files).merged.models[`${provider}/${model}`];
    return entry === undefined || !isCuratedPoolEntry(entry);
}

function catalogModel(provider: string, model: string, reasoningEffort?: ModelReasoningEffort): VeraCatalogModel {
    return {
        name: derivedModelName(provider as VeraProviderId, model),
        provider: provider as VeraProviderId,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    };
}

function moved(models: readonly VeraCatalogModel[], from: number, step: -1 | 1): readonly VeraCatalogModel[] {
    const to = from + step;
    if (from === -1 || to < 0 || to >= models.length) return models;
    const next = [...models];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
}
