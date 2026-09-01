import { fileURLToPath } from "node:url";

import type { VeraExtensionConfig } from "../config.ts";

export const SESSION_IDENTITY_EXTENSION_ID = "vera.session-identity";

export function defaultHostExtensionConfigs(
    disabledIds: readonly string[],
): readonly VeraExtensionConfig[] {
    if (disabledIds.includes(SESSION_IDENTITY_EXTENSION_ID)) {
        return [];
    }
    return [{
        path: fileURLToPath(new URL(
            "../../extensions/session-identity",
            import.meta.url,
        )),
        enabled: true,
        config: {},
    }];
}
