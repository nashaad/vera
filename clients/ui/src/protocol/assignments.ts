// What the desktop shell reads from and writes to the home's config.json for model assignments.

export type TierId = "snappy" | "eco" | "extra";
export type AssignmentId = TierId | "reviewer" | "compaction" | "subagents";

export const TIER_IDS: readonly TierId[] = ["snappy", "eco", "extra"];
export const ASSIGNMENT_IDS: readonly AssignmentId[] = ["snappy", "eco", "extra", "reviewer", "compaction", "subagents"];

export interface AssignedModel {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
}

export interface AssignmentSlot {
    readonly id: AssignmentId;
    readonly label: string;
    // True when config.json names models or a route for it.
    readonly bound: boolean;
    readonly route?: string;
    // The models config.json lists, in order. The classifier's second model is its failsafe.
    readonly declared: readonly AssignedModel[];
    // What runs now: the declared models that can be reached, or the tier's, or none for the session model.
    readonly running: readonly AssignedModel[];
    readonly source: "assignment" | "intent" | "session";
    // The tier an unset job runs on.
    readonly inherits?: TierId;
    // Subagents only: whether the spawning session's model is tried after the list.
    readonly allowSelf?: boolean;
}

export interface AssignmentsView {
    readonly ok: true;
    readonly slots: readonly AssignmentSlot[];
    // Set when config.json could not be read; the slots then come from the last read that worked.
    readonly notice?: string;
}

export interface AssignmentsFailure {
    readonly ok: false;
    readonly reason: string;
}

export type AssignmentsResult = AssignmentsView | AssignmentsFailure;

export interface AssignmentChange {
    readonly assignment: AssignmentId;
    readonly provider?: string;
    // Left out with no other field, the assignment is unset.
    readonly model?: string;
    readonly effort?: string;
    // Subagents only.
    readonly remove?: boolean;
    readonly allowSelf?: boolean;
    readonly move?: -1 | 1;
    // Classifier only: the model, or no model, answers when the classifier cannot.
    readonly failsafe?: boolean;
}

export interface AssignmentWritten {
    readonly ok: true;
    readonly view: AssignmentsView;
    // The assigned model is not a favorite yet and should become one.
    readonly favorite: boolean;
}

export type AssignmentWriteResult = AssignmentWritten | AssignmentsFailure;

export interface AssignedToAll {
    readonly ok: true;
    readonly view: AssignmentsView;
    readonly favorite: boolean;
    // Labels of the assignments the model was written to.
    readonly assigned: readonly string[];
    // Set when a write failed part way; the earlier ones stay written.
    readonly failure?: string;
}

export type AssignAllResult = AssignedToAll | AssignmentsFailure;

export function slotOf(view: AssignmentsView | undefined, id: AssignmentId): AssignmentSlot | undefined {
    return view?.slots.find((slot) => slot.id === id);
}

export function sameModel(left: AssignedModel | undefined, right: AssignedModel | undefined): boolean {
    return left !== undefined && right !== undefined && left.provider === right.provider && left.model === right.model;
}
