import type { JsonValue } from "./hooks.ts";

export interface VeraExtensionApi {
    readonly config: JsonValue;
    readonly workspace: string;
    onDispose(dispose: VeraExtensionDisposer): void;
}

export type VeraExtensionDisposer = () => void | Promise<void>;

export interface VeraExtensionModule {
    activate(vera: VeraExtensionApi): void | Promise<void>;
}
