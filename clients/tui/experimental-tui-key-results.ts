export interface TuiExperimentalKeyResultOptions {
    readonly onRenderRequested: () => void;
    readonly onFailure: (error: unknown) => void;
}

export function settleTuiExperimentalKeyResult(
    result: boolean | void,
    options: TuiExperimentalKeyResultOptions,
): boolean {
    if (
        typeof result === "object"
        && result !== null
        && "then" in result
    ) {
        options.onFailure(
            new Error("Experimental TUI onKey handlers must return synchronously"),
        );
        options.onRenderRequested();
        void Promise.resolve(result).catch((error) => {
            options.onFailure(error);
            options.onRenderRequested();
        });
        return false;
    }
    options.onRenderRequested();
    return result !== false;
}
