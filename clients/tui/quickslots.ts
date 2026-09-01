import type { ModelReasoningEffort } from "../../src/model/types.ts";

export interface Quickslot {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: ModelReasoningEffort;
}

export const QUICKSLOT_COUNT = 4;

export type Quickslots = readonly (Quickslot | null)[];

export function emptyQuickslots(): Quickslots {
    return Array.from({ length: QUICKSLOT_COUNT }, () => null);
}

export function withQuickslot(
    slots: Quickslots,
    index: number,
    quickslot: Quickslot | null,
): Quickslots {
    return slots.map((slot, position) =>
        position === index ? quickslot : slot
    );
}

export function sameQuickslot(left: Quickslot, right: Quickslot): boolean {
    return left.provider === right.provider
        && left.model === right.model
        && left.reasoningEffort === right.reasoningEffort;
}

export function nextQuickslot(
    slots: Quickslots,
    current: Quickslot | undefined,
): number | undefined {
    const start = current === undefined ? -1 : slots.findIndex((slot) =>
        slot !== null && sameQuickslot(slot, current)
    );
    for (let step = 1; step <= slots.length; step += 1) {
        const index = (start + step + slots.length) % slots.length;
        if (index !== start && slots[index] != null) {
            return index;
        }
    }
    return undefined;
}

export function quickslotLabel(quickslot: Quickslot): string {
    const name = quickslot.model.split("/").at(-1) ?? quickslot.model;
    return `${name} · ${quickslot.reasoningEffort}`;
}

interface DiskQuickslot {
    readonly provider: string;
    readonly model: string;
    readonly reasoning_effort: ModelReasoningEffort;
}

export type DiskQuickslots = readonly (DiskQuickslot | null)[];

export function parseQuickslots(value: unknown): Quickslots {
    const entries = Array.isArray(value) ? value : [];
    return Array.from(
        { length: QUICKSLOT_COUNT },
        (_, index) => asQuickslot(entries[index]),
    );
}

export function quickslotsForDisk(
    slots: Quickslots,
): DiskQuickslots {
    return slots.map((slot) =>
        slot === null ? null : {
            provider: slot.provider,
            model: slot.model,
            reasoning_effort: slot.reasoningEffort,
        }
    );
}

function asQuickslot(value: unknown): Quickslot | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const provider = Reflect.get(value, "provider");
    const model = Reflect.get(value, "model");
    const reasoningEffort = Reflect.get(value, "reasoning_effort");
    return typeof provider === "string" && provider.length > 0
            && typeof model === "string" && model.length > 0
            && isModelReasoningEffort(reasoningEffort)
        ? { provider, model, reasoningEffort }
        : null;
}

function isModelReasoningEffort(
    value: unknown,
): value is ModelReasoningEffort {
    return typeof value === "string" && value.length > 0;
}
