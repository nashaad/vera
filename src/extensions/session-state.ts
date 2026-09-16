export interface ExtensionSessionState {
    readonly [key: string]: string | number | boolean | null;
}

export interface ExtensionSessionStates {
    readonly [extensionId: string]: ExtensionSessionState;
}

export function isExtensionSessionState(value: unknown): value is ExtensionSessionState {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        && Object.values(value).every((item) => item === null || typeof item === "string"
            || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)));
}

export function isExtensionSessionStates(value: unknown): value is ExtensionSessionStates {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        && Object.values(value).every(isExtensionSessionState);
}
