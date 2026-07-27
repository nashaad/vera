type Preset = {
    provider: string;
    model: string;
    // A level id, not a fixed vocabulary: each model names its own levels, so
    // a preset saved on one model can hold a word another has never heard of.
    reasoningEffort: string;
};

type Slot = Preset | null;

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
            const current = currentPreset();
            const filled = slots
                .map((slot, index) => ({ slot, index }))
                .filter((entry) => entry.slot !== null);
            if (filled.length === 0) return;
            const currentIndex = filled.findIndex(
                (entry) => samePreset(entry.slot!, current),
            );
            const next = filled.length === 1 && currentIndex === 0
                ? undefined
                : filled[(currentIndex + 1) % filled.length]?.slot;
            if (next !== null && next !== undefined) {
                await vera.modelSettings.update(next);
            }
        },
    });

    async function openPicker(): Promise<void> {
        let selectedId: string | undefined;
        while (true) {
            const slots = await loadSlots();
            const current = currentPreset();
            const currentIndex = slots.findIndex((slot) =>
                slot !== null && samePreset(slot, current)
            );
            const result = await vera.ui.requestPicker({
                title: "Model presets",
                rows: slots.map((slot, index) => ({
                    id: `slot-${index + 1}`,
                    label: `Slot ${index + 1}`,
                    description: slot === null
                        ? "empty · ⏎ saves the current model"
                        : presetLabel(slot),
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
                await vera.modelSettings.update(slots[index]);
                return;
            }
            if (intent === "save") {
                const preset = currentPreset();
                if (preset !== undefined) {
                    slots[index] = preset;
                    await vera.preferences.set("slots", slots);
                }
                continue;
            }
            if (intent === "clear") {
                slots[index] = null;
                await vera.preferences.set("slots", slots);
            }
        }
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
