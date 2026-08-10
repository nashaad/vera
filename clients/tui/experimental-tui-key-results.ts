export interface TuiExperimentalKeyResultOptions {
    readonly onRenderRequested: () => void;
    readonly onFailure: (error: unknown) => void;
}

export function settleTuiExperimentalKeyResult(
    result: boolean | void | Promise<boolean | void>,
    options: TuiExperimentalKeyResultOptions,
): boolean {
    if (result instanceof Promise) {
        void result
            .then(() => options.onRenderRequested())
            .catch((error) => options.onFailure(error));
        return true;
    }
    options.onRenderRequested();
    return result !== false;
}
