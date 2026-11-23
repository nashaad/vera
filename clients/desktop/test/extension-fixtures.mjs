import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function markDesktopExtensionStoreMigrated(home) {
    mkdirSync(join(home, "machine", "desktop", "extensions.pre-plugins"), { recursive: true });
}
