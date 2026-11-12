import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LayoutState } from "../../ui/src/layout/model.ts";
import { parseLayout } from "../../ui/src/layout/saved.ts";

const MAX_LAYOUT_BYTES = 262_144;

// The layout sits in the desktop's own directory under the home. The host never reads it.
export function layoutPath(home: string): string {
    return join(home, "machine", "desktop", "layout.json");
}

export class LayoutStore {
    constructor(private readonly path: string) {}

    // An unreadable or invalid file means defaults; the file is kept aside as layout.json.bad.
    load(): LayoutState | undefined {
        let text: string;
        try {
            text = readFileSync(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.keepAside();
            return undefined;
        }
        let layout: LayoutState | undefined;
        if (text.length <= MAX_LAYOUT_BYTES) {
            try {
                layout = parseLayout(JSON.parse(text));
            } catch {
                layout = undefined;
            }
        }
        if (layout === undefined) this.keepAside();
        return layout;
    }

    // Writes a temp file and renames it over the layout, so a crash leaves the old file or the new one.
    save(value: unknown): boolean {
        const layout = parseLayout(value);
        if (layout === undefined) return false;
        const text = `${JSON.stringify(layout)}\n`;
        if (text.length > MAX_LAYOUT_BYTES) return false;
        const temp = `${this.path}.${process.pid}.tmp`;
        try {
            mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
            writeFileSync(temp, text, { mode: 0o600 });
            renameSync(temp, this.path);
            return true;
        } catch {
            rmSync(temp, { force: true });
            return false;
        }
    }

    private keepAside(): void {
        try {
            renameSync(this.path, `${this.path}.bad`);
        } catch {
            // Nothing to keep: the file vanished or the directory is not writable.
        }
    }
}
