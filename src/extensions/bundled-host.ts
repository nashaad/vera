import { fileURLToPath } from "node:url";

import type { VeraExtensionConfig } from "../config.ts";

export const ADVERSARIAL_EXTENSION_ID = "vera.adversarial";

export function bundledHostExtensionConfigs(
    disabledIds: readonly string[] = [],
): readonly VeraExtensionConfig[] {
    if (disabledIds.includes(ADVERSARIAL_EXTENSION_ID)) return [];
    return [{
        path: fileURLToPath(new URL(
            "../../extensions/adversarial",
            import.meta.url,
        )),
        enabled: true,
        config: {},
    }];
}
