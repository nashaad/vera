import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// One JSON file the desktop owns under the home. The host never reads it.
export class JsonFileStore<T> {
    constructor(
        private readonly path: string,
        private readonly maxBytes: number,
        private readonly parse: (value: unknown) => T | undefined,
    ) {}

    // An unreadable or invalid file reads as undefined; the file is kept aside with a .bad suffix.
    load(): T | undefined {
        let text: string;
        try {
            text = readFileSync(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.keepAside();
            return undefined;
        }
        let value: T | undefined;
        if (text.length <= this.maxBytes) {
            try {
                value = this.parse(JSON.parse(text));
            } catch {
                value = undefined;
            }
        }
        if (value === undefined) this.keepAside();
        return value;
    }

    // Writes a temp file and renames it over the old one, so a crash leaves the old file or the new one.
    save(input: unknown): boolean {
        const value = this.parse(input);
        if (value === undefined) return false;
        const text = `${JSON.stringify(value)}\n`;
        if (text.length > this.maxBytes) return false;
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
