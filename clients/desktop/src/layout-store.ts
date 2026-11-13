import { join } from "node:path";

import type { LayoutState } from "../../ui/src/layout/model.ts";
import { parseLayout } from "../../ui/src/layout/saved.ts";
import { JsonFileStore } from "./json-file-store.ts";

const MAX_LAYOUT_BYTES = 262_144;

export function layoutPath(home: string): string {
    return join(home, "machine", "desktop", "layout.json");
}

export class LayoutStore extends JsonFileStore<LayoutState> {
    constructor(path: string) {
        super(path, MAX_LAYOUT_BYTES, parseLayout);
    }
}
