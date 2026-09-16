import { fileURLToPath } from "node:url";

import type { VeraExtensionConfig } from "../config.ts";

export const SESSION_IDENTITY_EXTENSION_ID = "vera.session-identity";
export const EXPLORER_EXTENSION_ID = "vera.explorer";
export const WEB_SEARCH_EXTENSION_ID = "vera.web-search";

export function defaultHostExtensionConfigs(
    disabledIds: readonly string[],
): readonly VeraExtensionConfig[] {
    return [
        { id: SESSION_IDENTITY_EXTENSION_ID, directory: "session-identity" },
        { id: EXPLORER_EXTENSION_ID, directory: "explorer" },
        { id: "vera.budget", directory: "budget" },
        { id: "example.command-hooks", directory: "command-hooks" },
        { id: "example.plan", directory: "plan" },
        { id: WEB_SEARCH_EXTENSION_ID, directory: "web-search" },
    ].filter((entry) => !disabledIds.includes(entry.id))
        .map((entry) => ({
            path: fileURLToPath(new URL(
                `../../extensions/${entry.directory}`,
                import.meta.url,
            )),
            enabled: true,
            config: {},
        }));
}
