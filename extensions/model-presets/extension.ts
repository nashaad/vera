type Preset = {
    provider: string;
    model: string;
    // A level id, not a fixed vocabulary: each model names its own levels, so
    // a preset saved on one model can hold a word another has never heard of.
    reasoningEffort: string;
};

type Slot = Preset | null;

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
            // Cycling passes over a slot whose model cannot run: the key is
            // meant to land somewhere, and a slot that would be refused is a
            // dead stop. It keeps its contents, since the provider may return.
            const runnable = filled.filter((entry) =>
                entry.index === at || isRunnable(entry.slot)
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
                        : isRunnable(slot)
                        ? presetLabel(slot)
                        : `${presetLabel(slot)} · unavailable`,
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
        // Said before the update goes out: shift+tab is a key with no other
        // surface, so without this a refusal is the first thing the user hears
        // about the slot the key landed on.
        vera.ui.notice(`preset ${index + 1}: ${presetLabel(preset)}`);
        await vera.modelSettings.update(preset);
        await vera.preferences.set(CURRENT_SLOT_KEY, index);
    }

    /** Whether a slot's model could be switched to right now. */
    function isRunnable(preset: Preset): boolean {
        return vera.modelSettings.availability({
            provider: preset.provider,
            model: preset.model,
        }).runnable;
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

    function currentPreset(): Preset | undefined {
        const settings = vera.modelSettings.current();
        return settings?.provider === undefined
                || settings.model === undefined
                || settings.reasoningEffort === undefined
            ? undefined
            : {
                provider: settings.provider,
                model: settings.model,
                reasoningEffort: settings.reasoningEffort,
            };
    }

    async function loadSlots(): Promise<Slot[]> {
        const value = await vera.preferences.get("slots");
        if (!Array.isArray(value)) return [null, null, null, null];
        return Array.from({ length: 4 }, (_, index) =>
            asPreset(value[index])
        );
    }
}

function asPreset(value: unknown): Preset | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const provider = Reflect.get(value, "provider");
    const model = Reflect.get(value, "model");
    const reasoningEffort = Reflect.get(value, "reasoningEffort")
        ?? Reflect.get(value, "reasoning_effort");
    return typeof provider === "string"
            && typeof model === "string"
            && isEffort(reasoningEffort)
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

function samePreset(
    left: Preset | undefined,
    right: Preset | undefined,
): boolean {
    return left !== undefined
        && right !== undefined
        && left.provider === right.provider
        && left.model === right.model
        && left.reasoningEffort === right.reasoningEffort;
}

function presetLabel(preset: Preset): string {
    return `${preset.model.split("/").at(-1)} · ${preset.reasoningEffort}`;
}
