import type { ModelReasoningEffort } from "../../src/model/types.ts";

// A preset is one saved position of the dials `/model` and `/reasoning` already
// set. Nothing here is new capability: a slot can only ever hold a combination
// those two commands could reach on their own, so saving one records a state
// the session was already in, and applying one returns to it in a single key.
//
// This file is the preset domain only. It does not touch disk (that is
// theme-preference.ts) and does not know the picker exists (that is
// settings-picker.ts), so every rule below is testable as a plain function.

export interface ModelPreset {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: ModelReasoningEffort;
}

/**
 * Four numbered slots. Empty ones are held as `null` rather than left out, so a
 * slot keeps its number for the whole session: slot 3 stays slot 3 after slot 2
 * is cleared, and the numbers stay worth memorising.
 */
export const MODEL_PRESET_SLOT_COUNT = 4;

export type ModelPresetSlots = readonly (ModelPreset | null)[];

export function emptyModelPresetSlots(): ModelPresetSlots {
    return Array.from({ length: MODEL_PRESET_SLOT_COUNT }, () => null);
}

/** Save into a slot, or clear it by passing `null`. */
export function withModelPresetSlot(
    slots: ModelPresetSlots,
    index: number,
    preset: ModelPreset | null,
): ModelPresetSlots {
    return slots.map((slot, position) => position === index ? preset : slot);
}

export function sameModelPreset(left: ModelPreset, right: ModelPreset): boolean {
    return left.provider === right.provider
        && left.model === right.model
        && left.reasoningEffort === right.reasoningEffort;
}

/**
 * The slot the cycle key moves to: the first filled slot after whichever one
 * matches the current settings, wrapping past the end. Undefined when there is
 * nowhere different to land, so a lone saved preset does not re-send itself on
 * every press.
 *
 * Position is derived from the live settings rather than remembered, so a slot
 * saved, cleared, or overwritten mid-session cannot leave a stale cursor
 * behind, and `/model` used directly still lands the cycle in the right place.
 */
export function nextModelPresetSlot(
    slots: ModelPresetSlots,
    current: ModelPreset | undefined,
): number | undefined {
    const start = current === undefined ? -1 : slots.findIndex((slot) =>
        slot !== null && sameModelPreset(slot, current)
    );
    for (let step = 1; step <= slots.length; step += 1) {
        const index = (start + step + slots.length) % slots.length;
        if (index !== start && slots[index] != null) {
            return index;
        }
    }
    return undefined;
}

/**
 * How a saved slot reads in the picker: the model without its vendor prefix,
 * then the reasoning effort. Derived from what the slot holds rather than
 * stored beside it, so a slot never needs naming and its label can never go
 * stale against its contents.
 */
export function modelPresetLabel(preset: ModelPreset): string {
    const name = preset.model.split("/").at(-1) ?? preset.model;
    return `${name} · ${preset.reasoningEffort}`;
}

// On disk the fields are snake_case, matching how every other Vera
// configuration file spells them. The two functions below are the only place
// that spelling exists, so the rest of the client works in one shape.

interface DiskModelPreset {
    readonly provider: string;
    readonly model: string;
    readonly reasoning_effort: ModelReasoningEffort;
}

export type DiskModelPresetSlots = readonly (DiskModelPreset | null)[];

/**
 * Always returns exactly `MODEL_PRESET_SLOT_COUNT` entries, whatever was on
 * disk. A hand-edited or truncated file drops the unreadable slots instead of
 * failing, on the same reasoning as the rest of this preferences file: a bad
 * preference must never keep the TUI from starting.
 */
export function parseModelPresetSlots(value: unknown): ModelPresetSlots {
    const entries = Array.isArray(value) ? value : [];
    return Array.from(
        { length: MODEL_PRESET_SLOT_COUNT },
        (_, index) => asModelPreset(entries[index]),
    );
}

export function modelPresetSlotsForDisk(
    slots: ModelPresetSlots,
): DiskModelPresetSlots {
    return slots.map((slot) =>
        slot === null ? null : {
            provider: slot.provider,
            model: slot.model,
            reasoning_effort: slot.reasoningEffort,
        }
    );
}

function asModelPreset(value: unknown): ModelPreset | null {
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
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}
