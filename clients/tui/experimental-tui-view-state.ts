import type {
    VeraExperimentalTuiNode,
    VeraExperimentalTuiTheme,
} from "../../src/sdk/experimental-tui.ts";

export interface TuiExperimentalViewVisibilityOptions {
    readonly extensionId: string;
    readonly visible?: () => boolean;
    readonly onFailure: (extensionId: string, message: string) => void;
}

export function isTuiExperimentalViewVisible(
    options: TuiExperimentalViewVisibilityOptions,
): boolean {
    if (options.visible === undefined) return true;
    try {
        return options.visible() === true;
    } catch (error) {
        options.onFailure(
            options.extensionId,
            error instanceof Error ? error.message : String(error),
        );
        return false;
    }
}

export function tuiExperimentalViewSignature(
    node: VeraExperimentalTuiNode,
    focused: boolean,
    theme: VeraExperimentalTuiTheme,
): string | undefined {
    return JSON.stringify({ node, focused, theme });
}
