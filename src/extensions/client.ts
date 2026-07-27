import type { ExtensionCommandDescriptor } from "./commands.ts";
import { runExtensionOperation } from "./operation.ts";

export const CLIENT_EXTENSION_RESULT_VERSION = 1;

export interface ShowClientSurfaceAction {
    readonly kind: "client_action";
    readonly action: "show_help";
}

export interface ClientExtensionCommandResult {
    readonly version: typeof CLIENT_EXTENSION_RESULT_VERSION;
    readonly source: string;
    readonly body: ShowClientSurfaceAction;
}

export interface DirectClientExtension {
    readonly id: string;
    readonly commands: readonly ExtensionCommandDescriptor[];
    invokeCommand(
        name: string,
        argumentsText: string,
        options?: {
            readonly signal?: AbortSignal;
        },
    ): Promise<ClientExtensionCommandResult>;
}

export interface DirectClientCommandInvokeOptions {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

export async function invokeDirectClientExtensionCommand(
    extension: DirectClientExtension,
    name: string,
    argumentsText: string,
    options: DirectClientCommandInvokeOptions,
): Promise<ClientExtensionCommandResult> {
    return runExtensionOperation(
        (signal) => extension.invokeCommand(name, argumentsText, { signal }),
        {
            timeoutMs: options.timeoutMs,
            timeoutMessage:
                `Direct extension command timed out after ${options.timeoutMs}ms`,
            abortMessage: "Direct extension command aborted",
            ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
        },
    );
}
