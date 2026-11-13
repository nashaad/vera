import { join } from "node:path";

import { parsePins, type SavedPins } from "../../ui/src/protocol/pins.ts";
import { JsonFileStore } from "./json-file-store.ts";

const MAX_PINS_BYTES = 65_536;

export function pinsPath(home: string): string {
    return join(home, "machine", "desktop", "pins.json");
}

export class PinStore extends JsonFileStore<SavedPins> {
    constructor(path: string) {
        super(path, MAX_PINS_BYTES, parsePins);
    }
}
