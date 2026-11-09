export type OpenRouterErrors = typeof import("@openrouter/sdk/models/errors");

interface OpenRouterSdk {
    readonly sdk: typeof import("@openrouter/sdk");
    readonly errors: OpenRouterErrors;
}

let sdkPromise: Promise<OpenRouterSdk> | undefined;
let loadedErrors: OpenRouterErrors | undefined;

export function loadOpenRouterSdk(): Promise<OpenRouterSdk> {
    return sdkPromise ??= Promise.all([
        import("@openrouter/sdk"),
        import("@openrouter/sdk/models/errors"),
    ]).then(([sdk, errors]) => {
        loadedErrors = errors;
        return { sdk, errors };
    });
}

export function loadedOpenRouterErrors(): OpenRouterErrors | undefined {
    return loadedErrors;
}
