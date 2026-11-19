import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { importThemeFile } from "../../extensions/vscode-theme-import/import-theme.ts";
import { pirateCrowText, scratchDirectory, writeText } from "./theme-fixtures.ts";

export interface TarItem {
    readonly name: string;
    readonly data?: string | Buffer;
    // The tar type flag; "0" is a file and "5" a folder.
    readonly type?: string;
    readonly prefix?: string;
    // Overrides the size field, to describe an entry larger than its data.
    readonly size?: number;
}

function field(text: string, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    buffer.write(text, 0, "utf8");
    return buffer;
}

function header(item: TarItem, size: number): Buffer {
    const block = Buffer.alloc(512);
    field(item.name, 100).copy(block, 0);
    field("0000644\0", 8).copy(block, 100);
    field("0000000\0", 8).copy(block, 108);
    field("0000000\0", 8).copy(block, 116);
    field(`${(item.size ?? size).toString(8).padStart(11, "0")}\0`, 12).copy(block, 124);
    field("00000000000\0", 12).copy(block, 136);
    block.fill(0x20, 148, 156);
    block.write(item.type ?? (item.name.endsWith("/") ? "5" : "0"), 156, "ascii");
    block.write("ustar\0", 257, "ascii");
    block.write("00", 263, "ascii");
    if (item.prefix !== undefined) field(item.prefix, 155).copy(block, 345);
    let sum = 0;
    for (const byte of block) sum += byte;
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 8).copy(block, 148);
    return block;
}

// An uncompressed ustar archive, with the two empty blocks that end it.
export function tarBytes(items: readonly TarItem[]): Buffer {
    const parts: Buffer[] = [];
    for (const item of items) {
        const data = item.data === undefined ? Buffer.alloc(0) : Buffer.from(item.data);
        parts.push(header(item, data.length));
        if (data.length > 0) {
            parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
        }
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

export function tarGzBytes(items: readonly TarItem[]): Buffer {
    return gzipSync(tarBytes(items));
}

export function writePackage(items: readonly TarItem[], name = "package.tgz"): string {
    const path = join(scratchDirectory(), name);
    writeFileSync(path, tarGzBytes(items));
    return path;
}

export interface FixtureTheme {
    readonly label: string;
    // The saved theme's own name, which decides its slug.
    readonly name: string;
}

// The slug and file text of a saved theme the importer would write for this name.
export function savedTheme(name: string): { readonly slug: string; readonly text: string } {
    const outcome = importThemeFile(writeText(join(scratchDirectory(), "theme.json"), pirateCrowText({ name })));
    const theme = outcome.ok ? outcome.themes[0] : undefined;
    if (theme === undefined) throw new Error("The fixture theme did not import.");
    return { slug: theme.slug, text: JSON.stringify(theme) };
}

// The files of a themes-only extension package, at the archive root.
export function themeFiles(id: string, version: string, themes: readonly FixtureTheme[], extra: Record<string, unknown> = {}): TarItem[] {
    const items: TarItem[] = [];
    const contributed = themes.map((theme) => {
        const saved = savedTheme(theme.name);
        const path = `themes/${saved.slug}.json`;
        items.push({ name: path, data: saved.text });
        return { label: theme.label, path };
    });
    const manifest = { id, version, engine: DESKTOP_ENGINE, contributes: { themes: contributed }, ...extra };
    return [{ name: "vera.desktop.json", data: JSON.stringify(manifest) }, { name: "themes/", type: "5" }, ...items];
}
