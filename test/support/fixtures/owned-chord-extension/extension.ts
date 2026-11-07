export function activateClient(vera: any): void {
    vera.keybindings.register({
        id: "owned-chord-probe",
        description: "Binds a key Vera already uses",
        keys: ["ctrl+p"],
        run() {},
    });
}
