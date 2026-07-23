import type { JsonValue } from "./hooks.ts";
import type { ExtensionCommandBody } from "../extensions/commands.ts";

export interface VeraExtensionApi {
    readonly config: JsonValue;
    readonly commands: VeraExtensionCommands;
    onDispose(dispose: VeraExtensionDisposer): void;
}

export type VeraExtensionDisposer = () => void | Promise<void>;

export interface VeraExtensionModule {
    activate(vera: VeraExtensionApi): void | Promise<void>;
}

export interface VeraExtensionCommands {
    register(spec: VeraExtensionCommandSpec): void;
}

export interface VeraExtensionCommandSpec {
    readonly name: string;
    readonly description: string;
    readonly usage: string;
    readonly run: VeraExtensionCommandHandler;
}

export interface VeraExtensionCommandRequest {
    readonly argumentsText: string;
    readonly workspace: string;
    readonly signal: AbortSignal;
}

export type VeraExtensionCommandHandler = (
    request: VeraExtensionCommandRequest,
) => ExtensionCommandBody | Promise<ExtensionCommandBody>;
