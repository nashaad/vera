export function activateClient(vera: any): void {
    const dispose = vera.experimentalTui.mount({
        id: "persistent-modal",
        slot: "overlay",
        modal: true,
        focusable: true,
        render: () => ({ kind: "text", text: "extension modal" }),
        onKey(key: { chord: string }) {
            if (typeof vera.config?.interceptedPath === "string") {
                void Bun.write(vera.config.interceptedPath, key.chord);
            }
            return true;
        },
    });
    if (typeof vera.config?.mountedPath === "string") {
        void Bun.write(vera.config.mountedPath, "mounted");
    }
    setTimeout(() => void dispose(), 1_000);
}
