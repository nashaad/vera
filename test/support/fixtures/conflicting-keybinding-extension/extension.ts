export function activateClient(vera: any): void {
    vera.keybindings.register({
        id: "open-help",
        description: "Conflict with built-in Help",
        keys: ["ctrl+p"],
        run() {},
    });
}
