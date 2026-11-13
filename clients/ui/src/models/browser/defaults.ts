import {
    slotOf,
    TIER_IDS,
    type AssignedModel,
    type AssignmentId,
    type AssignmentSlot,
    type AssignmentsView,
    type TierId,
} from "../../protocol/assignments.ts";

export type SingleSlot = Exclude<AssignmentId, "subagents">;
// What a picker writes: one slot, the classifier's failsafe, a new subagent, or every default.
export type PickTarget = SingleSlot | "failsafe" | "subagent" | "all";
export type JobId = "reviewer" | "compaction";

export interface SlotCopy {
    readonly name: string;
    readonly about: string;
    readonly usedBy?: string;
}

export interface UnsetChoice {
    readonly label: string;
    readonly description: string;
}

export const JOB_IDS: readonly JobId[] = ["reviewer", "compaction"];

export const JOB_TIER: Record<JobId, TierId> = { reviewer: "extra", compaction: "eco" };

export const SLOT_COPY: Record<SingleSlot, SlotCopy> = {
    snappy: { name: "Snappy", about: "Dirt cheap and fast, for work nothing depends on.", usedBy: "titles and recaps" },
    eco: { name: "Eco", about: "Smart but fast, for work a turn waits on.", usedBy: "the explorer agent" },
    extra: { name: "Extra", about: "The most capable model, for work worth waiting for." },
    reviewer: { name: "Classifier", about: "Decides whether an action may run in Approve for me." },
    compaction: { name: "Compaction", about: "Summarizes a session that has run long." },
};

export const PICKER_TITLE: Record<PickTarget, string> = {
    snappy: "Assign a model to snappy",
    eco: "Assign a model to eco",
    extra: "Assign a model to extra",
    reviewer: "Assign the classifier",
    compaction: "Assign a model to compaction",
    failsafe: "Classifier failsafe",
    subagent: "Add a subagent model",
    all: "Assign one model to all",
};

export type ModelNamer = (model: AssignedModel) => string;

export function isTier(id: AssignmentId): id is TierId {
    return TIER_IDS.some((tier) => tier === id);
}

// The model config.json names first for a slot; undefined while it is not set.
export function primaryOf(view: AssignmentsView | undefined, id: SingleSlot): AssignedModel | undefined {
    const slot = slotOf(view, id);
    return slot?.bound === true ? slot.declared[0] : undefined;
}

export function failsafeOf(view: AssignmentsView | undefined): AssignedModel | undefined {
    const slot = slotOf(view, "reviewer");
    return slot?.bound === true ? slot.declared[1] : undefined;
}

export function currentOf(view: AssignmentsView | undefined, target: PickTarget): AssignedModel | undefined {
    if (target === "failsafe") return failsafeOf(view);
    if (target === "subagent" || target === "all") return undefined;
    return primaryOf(view, target);
}

// A set slot whose first model is not among the ones that can run now.
export function unreachable(slot: AssignmentSlot | undefined): boolean {
    const first = slot?.bound === true ? slot.declared[0] : undefined;
    return first !== undefined && !slot!.running.some((entry) => entry.provider === first.provider && entry.model === first.model);
}

// The jobs running on this tier because they are not set themselves.
export function leaningJobs(view: AssignmentsView | undefined, tier: TierId): readonly string[] {
    return JOB_IDS
        .filter((job) => JOB_TIER[job] === tier && slotOf(view, job)?.bound === false)
        .map((job) => SLOT_COPY[job].name.toLowerCase());
}

export function usedByText(view: AssignmentsView | undefined, tier: TierId): string | undefined {
    const users = [...(SLOT_COPY[tier].usedBy === undefined ? [] : [SLOT_COPY[tier].usedBy!]), ...leaningJobs(view, tier)];
    return users.length === 0 ? undefined : `Used by ${users.join(" and ")}.`;
}

// The picker's first row, which clears the target, and what clearing it means.
export function unsetChoice(view: AssignmentsView | undefined, target: PickTarget, name: ModelNamer): UnsetChoice | undefined {
    if (target === "subagent" || target === "all") return undefined;
    if (target === "failsafe") return { label: "None", description: "Vera asks you when the classifier cannot answer" };
    if (isTier(target)) return { label: "Not set", description: `Features that ask for ${target} do not run` };
    const tier = JOB_TIER[target];
    const running = slotOf(view, tier)?.running[0];
    return {
        label: "Not set",
        description: running === undefined
            ? `Uses ${SLOT_COPY[tier].name}, which is not set, so the session model`
            : `Uses ${SLOT_COPY[tier].name}, now ${name(running)}`,
    };
}

export function ordinal(position: number): string {
    if (position === 1) return "first";
    if (position === 2) return "second";
    if (position === 3) return "third";
    return `number ${position}`;
}

export function assignedText(target: SingleSlot, value: AssignedModel | undefined, name: ModelNamer, effort?: string): string {
    const slot = SLOT_COPY[target].name;
    if (value === undefined) return `${slot} is not set`;
    return effort === undefined ? `${slot} now uses ${name(value)}` : `${slot} now uses ${name(value)} at ${effort}`;
}

export function failsafeText(value: AssignedModel | undefined, name: ModelNamer): string {
    return value === undefined ? "The classifier has no failsafe" : `The failsafe is now ${name(value)}`;
}

export function subagentAddedText(value: AssignedModel, position: number, name: ModelNamer): string {
    return `Subagents can now run ${name(value)}, ${ordinal(position)} in order`;
}

// How many defaults a write changed, counting each slot's first model and its effort.
export function changedSlots(before: AssignmentsView | undefined, after: AssignmentsView): number {
    return after.slots.filter((slot) => {
        const was = slotOf(before, slot.id);
        const first = slot.bound ? slot.declared[0] : undefined;
        const old = was?.bound === true ? was.declared[0] : undefined;
        return first?.provider !== old?.provider || first?.model !== old?.model || first?.effort !== old?.effort;
    }).length;
}

export function allText(changed: number, value: AssignedModel, name: ModelNamer): string {
    if (changed === 0) return `Every default already uses ${name(value)}`;
    return `${changed} ${changed === 1 ? "default" : "defaults"} now use ${name(value)}`;
}
