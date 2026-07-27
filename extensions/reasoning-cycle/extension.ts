// Cycles the current model's own reasoning levels in place: no pane, no
// confirmation, just one step up the model's own ladder, wrapping back to the
// bottom past the top. This is the same dial `/reasoning <level>` turns, moved
// by one step instead of named, so applying it is a plain model-settings
// update.
//
// Levels arrive most capable first, so stepping up walks the list backwards.
// The direction is deliberate: a repeated tap should ask for more thinking,
// which is what someone reaching for the key generally wants.

// Bundled by Vera, but intentionally limited to the same public API as user extensions.
export function activateClient(vera: any): void {
    vera.keybindings.register({
        id: "cycle-reasoning",
        description: "Cycle the current model's reasoning level",
        keys: ["ctrl+t"],
        async run() {
            const levels = vera.modelSettings.currentLevels();
            if (levels.length === 0) {
                const settings = vera.modelSettings.current();
                throw new Error(
                    `${settings?.model ?? "this model"} has no reasoning effort setting`,
                );
            }
            // Where the model actually sits, which is not always what was last
            // requested: placing a level this model does not know is the
            // host's rule, not this extension's to re-derive.
            const current = vera.modelSettings.currentLevel();
            const index = levels.findIndex(
                (level: { id: string }) => level.id === current,
            );
            const next = levels[(index - 1 + levels.length) % levels.length];
            await vera.modelSettings.update({ reasoningEffort: next.id });
        },
    });
}
