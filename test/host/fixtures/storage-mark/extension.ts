import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { VeraExtensionApi } from "../../../../src/sdk/extensions.ts";

export function activate(vera: VeraExtensionApi): void {
    writeFileSync(join(vera.storage.profile, "activated.txt"), "profile");
    writeFileSync(join(vera.storage.machine, "activated.txt"), "machine");
    vera.hooks.registerTurnFinished(() => undefined);
}
