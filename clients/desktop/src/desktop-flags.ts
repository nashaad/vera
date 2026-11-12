import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_DESKTOP_FLAGS, parseFlags, type DesktopFlags } from "../../ui/src/state/desktopFlags.ts";

export { DEFAULT_DESKTOP_FLAGS };

const MAX_FLAGS_BYTES = 4_096;

// Flags sit in the desktop's own directory under the home, beside the layout. The host never reads them.
export function flagsPath(home: string): string {
    return join(home, "machine", "desktop", "flags.json");
}

// A missing, oversized or invalid file means every flag at its default.
export function readFlags(path: string): DesktopFlags {
    try {
        const text = readFileSync(path, "utf8");
        if (text.length > MAX_FLAGS_BYTES) return DEFAULT_DESKTOP_FLAGS;
        return parseFlags(JSON.parse(text));
    } catch {
        return DEFAULT_DESKTOP_FLAGS;
    }
}
