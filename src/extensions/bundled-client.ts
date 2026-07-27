import { fileURLToPath } from "node:url";

import {
    CLIENT_EXTENSION_RESULT_VERSION,
    type DirectClientExtension,
} from "./client.ts";
import type { ClientExtensionConfig } from "./client-registry.ts";

const HELP_EXTENSION_ID = "vera.help";
const MODEL_PRESETS_EXTENSION_ID = "vera.model-presets";
const REASONING_CYCLE_EXTENSION_ID = "vera.reasoning-cycle";

export function bundledClientExtensionConfigs(
    disabledIds: readonly string[],
): readonly ClientExtensionConfig[] {
    const configs: ClientExtensionConfig[] = [];
    if (!disabledIds.includes(MODEL_PRESETS_EXTENSION_ID)) {
        configs.push({
            path: fileURLToPath(new URL(
                "../../extensions/model-presets",
                import.meta.url,
            )),
            enabled: true,
            config: {},
        });
    }
    if (!disabledIds.includes(REASONING_CYCLE_EXTENSION_ID)) {
        configs.push({
            path: fileURLToPath(new URL(
                "../../extensions/reasoning-cycle",
                import.meta.url,
            )),
            enabled: true,
            config: {},
        });
    }
    return configs;
}

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
