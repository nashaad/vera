import type { ExtensionCommandDescriptor } from "../extensions/commands.ts";
import {
    ExtensionCommandError,
    parseExtensionCommandList,
    parseExtensionFailure,
} from "./attached-client.ts";
import { connectHost } from "./connection.ts";

export async function listExtensionCommandsThroughHost(
    socketPath: string,
    responseTimeoutMs = 2_000,
): Promise<readonly ExtensionCommandDescriptor[]> {
    const connection = await connectHost({ socketPath });
    try {
        const requestId = "extension-commands";
        await connection.send({
            type: "list_extension_commands",
            request_id: requestId,
        });
        const value = await connection.receiveWithin(
            responseTimeoutMs,
            "Host extension command list deadline exceeded",
        );
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("Host sent an invalid extension response");
        }
        const response = value as Record<string, unknown>;
        if (response.request_id !== requestId) {
            throw new Error("Host sent an invalid extension response");
        }
        if (response.type === "extension_command_failed") {
            const failure = parseExtensionFailure(response);
            if (failure === undefined) {
                throw new Error("Host sent an invalid extension response");
            }
            throw new ExtensionCommandError(
                failure.message ?? `Extension command failed: ${failure.reason}`,
                failure.source,
                failure.reason,
            );
        }
        const commands = parseExtensionCommandList(response);
        if (commands === undefined) {
            throw new Error("Host sent an invalid extension response");
        }
        return commands;
    } finally {
        connection.close();
    }
}
