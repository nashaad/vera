import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    DEFAULT_DESKTOP_FLAGS,
    defaultFlags,
    parseFlagPatch,
    parseFlags,
    type DesktopFlags,
} from "../../ui/src/state/desktopFlags.ts";
import { JsonFileStore } from "./json-file-store.ts";

export { DEFAULT_DESKTOP_FLAGS };

export const MAX_FLAGS_BYTES = 4_096;

// Flags sit in the desktop's own directory under the home, beside the layout. The host never reads them.
export function flagsPath(home: string): string {
    return join(home, "machine", "desktop", "flags.json");
}

// A missing, oversized or invalid file means every flag at its build default. Reading never changes the file.
export function readFlags(path: string, packaged = true): DesktopFlags {
    const defaults = defaultFlags(packaged);
    try {
        const text = readFileSync(path, "utf8");
        if (text.length > MAX_FLAGS_BYTES) return defaults;
        return parseFlags(JSON.parse(text), defaults);
    } catch {
        return defaults;
    }
}

type StoredFlags = Readonly<Record<string, unknown>>;

function parseStored(value: unknown): StoredFlags | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as StoredFlags) : undefined;
}

// Writes only what the person chose, so a part the file does not name keeps following the build default.
// Keys the desktop does not know stay in the file.
export class FlagsStore extends JsonFileStore<StoredFlags> {
    constructor(private readonly filePath: string, private readonly packaged: boolean) {
        super(filePath, MAX_FLAGS_BYTES, parseStored);
    }

    read(): DesktopFlags {
        return readFlags(this.filePath, this.packaged);
    }

    // The flags after the change, or undefined when the patch was refused or the file could not be written.
    update(input: unknown): DesktopFlags | undefined {
        const patch = parseFlagPatch(input);
        if (patch === undefined) return undefined;
        if (!this.save({ ...(this.load() ?? {}), ...patch })) return undefined;
        return this.read();
    }
}
