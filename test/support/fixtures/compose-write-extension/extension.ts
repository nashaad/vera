export function activateClient(vera: any): void {
    vera.commands.register({
        name: "compose-write",
        description: "Insert text into the composer",
        usage: "/compose-write",
        run() {
            const inserted = vera.compose.insert("inserted by extension");
            const focused = vera.compose.focus();
            if (inserted.status !== "accepted" || focused.status !== "accepted") {
                return {
                    kind: "notice",
                    level: "error",
                    text: `compose ${inserted.status}/${focused.status}`,
                };
            }
            return { kind: "handled" };
        },
    });
    vera.commands.register({
        name: "compose-focus-guard",
        description: "Check composer focus around an extension modal",
        usage: "/compose-focus-guard",
        async run() {
            const dispose = vera.experimentalTui.mount({
                id: "focus-guard",
                slot: "overlay",
                modal: true,
                focusable: true,
                render: () => ({ kind: "text", text: "extension modal" }),
            });
            const covered = vera.compose.focus();
            await dispose();
            const restored = vera.compose.focus();
            if (typeof vera.config?.focusResultPath === "string") {
                await Bun.write(
                    vera.config.focusResultPath,
                    `${covered.status}/${restored.status}`,
                );
            }
            return { kind: "handled" };
        },
    });
    vera.keybindings.register({
        id: "compose-write-key",
        description: "Insert text into the active draft",
        keys: ["ctrl+k"],
        run() {
            vera.compose.insert("injected while queued");
        },
    });
    vera.keybindings.register({
        id: "compose-write-late",
        description: "Try a delayed composer insertion",
        keys: ["ctrl+l"],
        async run() {
            await Bun.sleep(300);
            const result = vera.compose.insert("stale text must not land");
            if (typeof vera.config?.delayedResultPath === "string") {
                await Bun.write(vera.config.delayedResultPath, result.status);
            }
        },
    });
}
