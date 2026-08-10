import type {
    VeraExperimentalTuiAgentSurfaceSnapshot,
} from "../../src/sdk/experimental-tui.ts";

export interface TuiHostedAgentSurfaceOptions {
    owner(): string | undefined;
    hasAgent(): boolean;
    layout(): "split" | "main" | "sidebar";
    isFocused(): boolean;
    cycleSidebarLayout(): void;
    setSidebarFocused(focused: boolean): void;
    focusComposer(): void;
    renderState(): void;
    renderStatus(): void;
    requestRender(): void;
}

export interface TuiHostedAgentSurface {
    current(
        extensionId: string,
    ): VeraExperimentalTuiAgentSurfaceSnapshot | undefined;
    cycleLayout(extensionId: string): boolean;
    toggleFocus(extensionId: string): boolean;
}

export function createTuiHostedAgentSurface(
    options: TuiHostedAgentSurfaceOptions,
): TuiHostedAgentSurface {
    function isOwner(extensionId: string): boolean {
        return options.owner() === extensionId && options.hasAgent();
    }

    return {
        current(extensionId) {
            if (!isOwner(extensionId)) return undefined;
            const layout = options.layout();
            return {
                layout: layout === "sidebar"
                    ? "secondary"
                    : layout === "main" ? "primary" : "split",
                focused: options.isFocused()
                    ? "secondary"
                    : "primary",
            };
        },
        cycleLayout(extensionId) {
            if (!isOwner(extensionId)) return false;
            options.cycleSidebarLayout();
            options.focusComposer();
            options.renderState();
            options.renderStatus();
            options.requestRender();
            return true;
        },
        toggleFocus(extensionId) {
            if (
                !isOwner(extensionId)
                || options.layout() !== "split"
            ) return false;
            options.setSidebarFocused(!options.isFocused());
            options.focusComposer();
            options.renderState();
            return true;
        },
    };
}
