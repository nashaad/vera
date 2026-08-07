// A preset holds either a pool entry's name or a `provider/model` id. The name
// is the entry's identity, so a slot that holds one follows a rename or a
// re-pointed entry instead of pinning whatever the name meant when it was
// saved. A slot only ever holds one of the two forms, never both.

interface NamedPreset {
    readonly name: string;
    // A level id, not a fixed vocabulary: each model names its own levels, so
    // a preset saved on one model can hold a word another has never heard of.
    readonly reasoningEffort: string;
}

interface IdPreset {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
}

type Preset = NamedPreset | IdPreset;

type Slot = Preset | null;

interface ModelTarget {
    readonly provider: string;
    readonly model: string;
}

/**
 * What a slot can do right now. `stale` belongs to the name form alone: the
 * name resolves to nothing, so there is no model to switch to and no id left
 * to fall back on. `unavailable` still knows its model; only the provider is
 * missing, and it may come back.
 */
type SlotState = "ready" | "unavailable" | "stale";

/** Where the slot you are on is remembered, since the model cannot say. */
const CURRENT_SLOT_KEY = "current-slot";

// Bundled by Vera, but intentionally limited to the same public API as user extensions.
export function activateClient(vera: any): void {
    vera.commands.register({
        name: "preset",
        description: "Save and switch between model presets",
        usage: "/preset",
        palette: {
            label: "Model presets",
            description: "save the current model, or switch to a saved one",
            group: "Settings",
            keyHint: "shift+tab",
        },
        interactive: true,
        async run() {
            await openPicker();
        },
    });
    vera.keybindings.register({
        id: "cycle-preset",
        description: "Cycle model presets",
        keys: ["shift+tab"],
        async run() {
            const slots = await loadSlots();
            const filled = slots.flatMap((slot, index) =>
                slot === null ? [] : [{ slot, index }]
            );
            // Nothing to cycle between, and a keybinding has no way to say so.
            // Showing the slots answers both "you have not saved one yet" and
            // "the only one you have is the one you are already on".
            if (filled.length < 2) {
                await openPicker();
                return;
            }
            const at = await currentSlotIndex(slots);
            const position = filled.findIndex((entry) => entry.index === at);
            // A model that came from somewhere else leaves position at -1,
            // which starts the cycle at the first filled slot.
            // Cycling passes over a slot the key could not land on: a model no
            // provider offers, or a name the pool no longer has. Both keep
            // their contents, since either can come back.
            const runnable = filled.filter((entry) =>
                entry.index === at || slotState(entry.slot) === "ready"
            );
            const pool = runnable.length > 1 ? runnable : filled;
            const at2 = pool.findIndex((entry) => entry.index === at);
            const next = pool[(at2 + 1) % pool.length]!;
            await applySlot(next.index, next.slot);
        },
    });

    async function openPicker(): Promise<void> {
        let selectedId: string | undefined;
        while (true) {
            const slots = await loadSlots();
            const currentIndex = await currentSlotIndex(slots);
            const result = await vera.ui.requestPicker({
                title: "Model presets",
                subtitle: "Switching models may reset the KV cache. The next turn will be slower.",
                rows: slots.map((slot, index) => ({
                    id: `slot-${index + 1}`,
                    label: `Slot ${index + 1}`,
                    description: slot === null
                        ? "empty · ⏎ saves the current model"
                        : slotDescription(slot),
                    current: index === currentIndex,
                })),
                selectedId: selectedId
                    ?? (currentIndex < 0
                        ? "slot-1"
                        : `slot-${currentIndex + 1}`),
                actions: [
                    { id: "choose", label: "apply/save", keys: ["enter"] },
                    { id: "save", label: "save", keys: ["s"] },
                    {
                        id: "clear",
                        label: "clear",
                        keys: ["delete", "backspace"],
                    },
                ],
            });
            if (result.outcome === "cancelled") return;

            const index = Number(result.rowId.slice("slot-".length)) - 1;
            if (!Number.isInteger(index) || index < 0 || index >= slots.length) {
                return;
            }
            selectedId = result.rowId;
            const intent = result.actionId === "choose" && slots[index] === null
                ? "save"
                : result.actionId;
            if (intent === "choose") {
                await applySlot(index, slots[index]!);
                return;
            }
            if (intent === "save") {
                const preset = currentPreset();
                if (preset !== undefined) {
                    slots[index] = preset;
                    await vera.preferences.set("slots", slots);
                    // Saving the model you are on into a slot puts you on that
                    // slot, so the cycle continues from there rather than from
                    // whichever other slot happens to hold the same preset.
                    await vera.preferences.set(CURRENT_SLOT_KEY, index);
                }
                continue;
            }
            if (intent === "clear") {
                slots[index] = null;
                await vera.preferences.set("slots", slots);
            }
        }
    }

    /**
     * Put a slot's preset on, and remember that it is the one you are on.
     *
     * The remembering is the point. Two slots may hold the same preset, so
     * "which slot am I on" is not recoverable from the model afterwards.
     */
    async function applySlot(index: number, preset: Preset): Promise<void> {
        const target = resolveTarget(preset);
        // A stale name has nothing to apply, and quietly leaving the model
        // where it is would read as the key doing nothing. Naming the name is
        // the only way the user can tell which slot to fix.
        if (target === undefined) {
            vera.ui.notice(
                `preset ${index + 1}: no pooled model named ${
                    (preset as NamedPreset).name
                }`,
            );
            return;
        }
        // Said before the update goes out: shift+tab is a key with no other
        // surface, so without this a refusal is the first thing the user hears
        // about the slot the key landed on.
        vera.ui.notice(`preset ${index + 1}: ${presetLabel(preset)}`);
        await vera.modelSettings.update({
            provider: target.provider,
            model: target.model,
            reasoningEffort: preset.reasoningEffort,
        });
        await vera.preferences.set(CURRENT_SLOT_KEY, index);
    }

    /**
     * The model a slot stands for, or undefined when a name no longer resolves.
     *
     * Resolved on every use rather than at save, against the pool as it is
     * now: a renamed, re-pointed or unpooled entry has to reach the slot that
     * named it. An ambiguous name resolves to nothing here because the pool
     * drops a repeated name before it reaches this list.
     */
    function resolveTarget(preset: Preset): ModelTarget | undefined {
        if (!isNamed(preset)) {
            return { provider: preset.provider, model: preset.model };
        }
        const pooled = vera.modelSettings.current()?.pooled ?? [];
        const entry = pooled.find(
            (candidate: { poolName?: string }) =>
                candidate.poolName === preset.name,
        );
        return entry === undefined
            ? undefined
            : { provider: entry.provider, model: entry.model };
    }

    /** Whether a slot could be switched to right now, and why not. */
    function slotState(preset: Preset): SlotState {
        const target = resolveTarget(preset);
        if (target === undefined) {
            return "stale";
        }
        return vera.modelSettings.availability(target).runnable
            ? "ready"
            : "unavailable";
    }

    function slotDescription(preset: Preset): string {
        const state = slotState(preset);
        if (state === "ready") {
            return presetLabel(preset);
        }
        return `${presetLabel(preset)} · ${
            state === "stale" ? "stale name" : "unavailable"
        }`;
    }

    /**
     * The slot the current model came from, or -1 when it came from elsewhere.
     *
     * The remembered index is only trusted while the model still matches what
     * that slot holds: the model picker, a preset overwritten in another
     * session, and a cleared slot all change the answer without going through
     * here. Matching by value is the fallback rather than the answer, because
     * with two slots holding one preset it can only name the first of them,
     * which is what made cycling stick.
     */
    async function currentSlotIndex(slots: readonly Slot[]): Promise<number> {
        const current = currentPreset();
        const remembered = await vera.preferences.get(CURRENT_SLOT_KEY);
        if (Number.isInteger(remembered)) {
            const slot = slots[remembered as number];
            if (slot !== null && slot !== undefined && samePreset(slot, current)) {
                return remembered as number;
            }
        }
        return slots.findIndex((slot) =>
            slot !== null && samePreset(slot, current)
        );
    }

    /**
     * The dials as they stand, in the form a slot should keep them. A model
     * the user has named is stored by that name: the name is what saving it
     * meant, and the id it resolves to is the pool's business afterwards.
     */
    function currentPreset(): Preset | undefined {
        const settings = vera.modelSettings.current();
        if (
            settings?.provider === undefined
            || settings.model === undefined
            || settings.reasoningEffort === undefined
        ) {
            return undefined;
        }
        const pooled = settings.pooled ?? [];
        const named = pooled.find(
            (candidate: ModelTarget & { poolName?: string }) =>
                candidate.provider === settings.provider
                && candidate.model === settings.model,
        );
        return named?.poolName === undefined ? {
            provider: settings.provider,
            model: settings.model,
            reasoningEffort: settings.reasoningEffort,
        } : {
            name: named.poolName,
            reasoningEffort: settings.reasoningEffort,
        };
    }

    /**
     * Whether two presets put the same dials on. Compared after resolution, so
     * a slot holding a name still matches the model it points at however that
     * model was reached. Two stale slots never match: neither stands for a
     * model, so neither can be the one you are on.
     */
    function samePreset(
        left: Preset | undefined,
        right: Preset | undefined,
    ): boolean {
        if (
            left === undefined || right === undefined
            || left.reasoningEffort !== right.reasoningEffort
        ) {
            return false;
        }
        const leftTarget = resolveTarget(left);
        const rightTarget = resolveTarget(right);
        return leftTarget !== undefined
            && rightTarget !== undefined
            && leftTarget.provider === rightTarget.provider
            && leftTarget.model === rightTarget.model;
    }

    async function loadSlots(): Promise<Slot[]> {
        const value = await vera.preferences.get("slots");
        if (!Array.isArray(value)) return [null, null, null, null];
        return Array.from({ length: 4 }, (_, index) =>
            asPreset(value[index])
        );
    }
}

function isNamed(preset: Preset): preset is NamedPreset {
    return "name" in preset;
}

function asPreset(value: unknown): Preset | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const name = Reflect.get(value, "name");
    const provider = Reflect.get(value, "provider");
    const model = Reflect.get(value, "model");
    const reasoningEffort = Reflect.get(value, "reasoningEffort")
        ?? Reflect.get(value, "reasoning_effort");
    if (!isEffort(reasoningEffort)) {
        return null;
    }
    // The name wins when both forms are present. A hand-written slot carrying
    // an id beside a name would otherwise keep the id after the name moved,
    // which is the drift the name form exists to avoid.
    if (typeof name === "string" && name.length > 0) {
        return { name, reasoningEffort };
    }
    return typeof provider === "string" && typeof model === "string"
        ? { provider, model, reasoningEffort }
        : null;
}

function isEffort(
    value: unknown,
): value is Preset["reasoningEffort"] {
    return value === "off"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "max";
}

function presetLabel(preset: Preset): string {
    const model = isNamed(preset)
        ? preset.name
        : preset.model.split("/").at(-1);
    return `${model} · ${preset.reasoningEffort}`;
}
