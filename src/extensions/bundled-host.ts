import { fileURLToPath } from "node:url";

import type { VeraExtensionConfig } from "../config.ts";

export const SESSION_IDENTITY_EXTENSION_ID = "vera.session-identity";

/**
 * Host extensions Vera ships and loads unless the profile disables them.
 * Naming lives here rather than in the host so a different namer can replace
 * this one without a host change.
 */
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
