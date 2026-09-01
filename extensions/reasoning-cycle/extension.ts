
export function activateClient(vera: any): void {
    vera.keybindings.register({
        id: "cycle-reasoning",
        description: "Cycle the current model's reasoning level",
        keys: ["ctrl+y"],
        async run() {
            const levels = vera.modelSettings.currentLevels();
            if (levels.length === 0) {
                const settings = vera.modelSettings.current();
                throw new Error(
                    `${settings?.model ?? "this model"} has no reasoning effort setting`,
                );
            }
            const current = vera.modelSettings.currentLevel();
            const index = levels.findIndex(
                (level: { id: string }) => level.id === current,
            );
            const next = levels[(index - 1 + levels.length) % levels.length];
            await vera.modelSettings.update({ reasoningEffort: next.id });
        },
    });
}
