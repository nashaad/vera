import type { ExtensionCommandDescriptor } from "./commands.ts";

export const CLIENT_EXTENSION_RESULT_VERSION = 1;

export interface ShowCommandsClientAction {
    readonly kind: "client_action";
    readonly action: "show_commands";
}

export interface ClientExtensionCommandResult {
    readonly version: typeof CLIENT_EXTENSION_RESULT_VERSION;
    readonly source: string;
    readonly body: ShowCommandsClientAction;
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
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
        abort();
    }
    const timeout = setTimeout(() => {
        controller.abort(new Error(
            `Direct extension command timed out after ${options.timeoutMs}ms`,
        ));
    }, options.timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => {
            reject(controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error("Direct extension command aborted"));
        };
        if (controller.signal.aborted) {
            rejectAbort();
            return;
        }
        controller.signal.addEventListener("abort", rejectAbort, {
            once: true,
        });
    });
    try {
        return await Promise.race([
            extension.invokeCommand(name, argumentsText, {
                signal: controller.signal,
            }),
            aborted,
        ]);
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
    }
}
