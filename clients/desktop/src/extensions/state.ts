import { JsonFileStore } from "../json-file-store.ts";

const MAX_STATE_BYTES = 64 * 1024;
const MAX_DISABLED = 1000;
const MAX_ID_CHARS = 80;

export interface ExtensionState {
    readonly version: 1;
    // Ids of the extensions the person turned off. An extension not listed is on.
    readonly disabled: readonly string[];
}

function parseState(value: unknown): ExtensionState | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const { version, disabled } = value as { version?: unknown; disabled?: unknown };
    if (version !== 1 || !Array.isArray(disabled)) return undefined;
    const ids = new Set<string>();
    for (const id of disabled) {
        if (typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS) ids.add(id);
        if (ids.size >= MAX_DISABLED) break;
    }
    return { version: 1, disabled: [...ids].sort() };
}

// Which extensions are turned off, in one small file beside the other desktop files.
export class ExtensionStateStore extends JsonFileStore<ExtensionState> {
    constructor(path: string) {
        super(path, MAX_STATE_BYTES, parseState);
    }

    disabled(): ReadonlySet<string> {
        return new Set(this.load()?.disabled ?? []);
    }

    // False when the file could not be written.
    setEnabled(id: string, enabled: boolean): boolean {
        const disabled = new Set(this.disabled());
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return this.save({ version: 1, disabled: [...disabled] });
    }
}
