import {
    CLIENT_EXTENSION_RESULT_VERSION,
    type DirectClientExtension,
} from "./client.ts";

const HELP_EXTENSION_ID = "vera.help";

export function bundledClientExtensions(): readonly DirectClientExtension[] {
    return [{
        id: HELP_EXTENSION_ID,
        commands: [{
            name: "help",
            description: "Learn Vera controls and commands",
            usage: "/help",
            source: HELP_EXTENSION_ID,
        }],
        async invokeCommand(name, argumentsText, options) {
            options?.signal?.throwIfAborted();
            if (name !== "help" || argumentsText.length > 0) {
                throw new Error(`Usage: /${name}`);
            }
            return {
                version: CLIENT_EXTENSION_RESULT_VERSION,
                source: `${HELP_EXTENSION_ID}/${name}`,
                body: {
                    kind: "client_action",
                    action: "show_help",
                },
            };
        },
    }];
}
