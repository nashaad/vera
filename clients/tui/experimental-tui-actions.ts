import type { VeraExperimentalTuiContext } from "../../src/sdk/experimental-tui.ts";

export interface TuiExperimentalActionOptions {
    readonly action: string;
    readonly context: VeraExperimentalTuiContext;
    readonly onAction?: (
        action: string,
        context: VeraExperimentalTuiContext,
    ) => void | Promise<void>;
    readonly onFailure: (error: unknown) => void;
    readonly onRenderRequested: () => void;
}

export function invokeTuiExperimentalAction(
    options: TuiExperimentalActionOptions,
): Promise<void> {
    if (options.onAction === undefined) return Promise.resolve();
    try {
        return Promise.resolve(options.onAction(options.action, options.context))
            .catch((error) => options.onFailure(error))
            .then(() => options.onRenderRequested());
    } catch (error) {
        options.onFailure(error);
        options.onRenderRequested();
        return Promise.resolve();
    }
}
