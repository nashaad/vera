import type { CommandRegistry } from "./registry.ts";

export function reloadPage(nativeFocused = false): void {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-page-reload]:not(:disabled)")]
        .filter((button) => button.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible");
    if (nativeFocused) {
        buttons.find((button) => button.hasAttribute("data-page-native"))?.click();
        return;
    }
    const focused = document.activeElement;
    const target = buttons.find((button) => button.closest(".browser, .file-preview")?.contains(focused))
        ?? buttons.find((button) => button.closest('[data-location="rightPane"]') !== null)
        ?? buttons[0];
    target?.click();
}

export function registerReloadPage(commands: CommandRegistry): () => void {
    return commands.register({ id: "page.reload", title: "Reload Page", run: (args) => reloadPage(args === "native") });
}
