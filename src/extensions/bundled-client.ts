import {
    CLIENT_EXTENSION_RESULT_VERSION,
    type DirectClientExtension,
} from "./client.ts";

const HELP_EXTENSION_ID = "vera.help";

export const BUNDLED_CLIENT_COMMAND_NAMES = ["help"] as const;

export function bundledClientExtensions(): readonly DirectClientExtension[] {
    return [{
        id: HELP_EXTENSION_ID,
        commands: [{
            name: "help",
            description: "Browse available commands",
            usage: "/help",
            source: HELP_EXTENSION_ID,
        }],
        async invokeCommand(name, argumentsText, options) {
            options?.signal?.throwIfAborted();
            if (name !== "help" || argumentsText.length > 0) {
                throw new Error("Usage: /help");
            }
            return {
                version: CLIENT_EXTENSION_RESULT_VERSION,
                source: `${HELP_EXTENSION_ID}/help`,
                body: {
                    kind: "client_action",
                    action: "show_commands",
                },
            };
        },
    }];
}
