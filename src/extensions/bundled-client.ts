import { fileURLToPath } from "node:url";

import {
    CLIENT_EXTENSION_RESULT_VERSION,
    type DirectClientExtension,
} from "./client.ts";
import type { ClientExtensionConfig } from "./client-registry.ts";

const HELP_EXTENSION_ID = "vera.help";
const REASONING_CYCLE_EXTENSION_ID = "vera.reasoning-cycle";

export function bundledClientExtensionConfigs(
    disabledIds: readonly string[],
): readonly ClientExtensionConfig[] {
    const configs: ClientExtensionConfig[] = [];
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
    if (!disabledIds.includes("vera.customize")) {
        configs.push({ path: fileURLToPath(new URL("../../extensions/customize", import.meta.url)), enabled: true, config: {} });
    }
    if (!disabledIds.includes("vera.budget")) {
        configs.push({ path: fileURLToPath(new URL("../../extensions/budget", import.meta.url)), enabled: true, config: {} });
    }
    for (const entry of [
        { id: "example.plan", directory: "plan" },
        { id: "vera.btw", directory: "btw" },
        { id: "vera.diff", directory: "diff" },
        { id: "example.context", directory: "context" },
    ]) {
        if (disabledIds.includes(entry.id)) continue;
        configs.push({
            path: fileURLToPath(new URL(
                `../../extensions/${entry.directory}`,
                import.meta.url,
            )),
            enabled: true,
            config: {},
        });
    }
    if (!disabledIds.includes("vera.web-search")) {
        configs.push({ path: fileURLToPath(new URL("../../extensions/web-search", import.meta.url)), enabled: true, config: {} });
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
