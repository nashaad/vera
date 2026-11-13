import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";

const scratch: string[] = [];

export function scratchDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-theme-import-"));
    scratch.push(directory);
    return directory;
}

export function removeScratchDirectories(): void {
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function writeText(path: string, text: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
}

export const PIRATE_CROW = {
    name: "Pirate Crow",
    type: "dark",
    colors: {
        "editor.background": "#10131a",
        "sideBar.background": "#0c0f15",
        "panel.border": "#2a3140",
        "editorWidget.background": "#171b24",
        foreground: "#d7dae0",
        descriptionForeground: "#8b93a3",
        "button.background": "#c9a227",
        "button.foreground": "#10131a",
        errorForeground: "#e5484d",
        "terminal.ansiGreen": "#4ade80",
        "diffEditor.insertedTextBackground": "#4ade8033",
        "widget.shadow": "#00000099",
    },
    tokenColors: [{ scope: "comment", settings: { foreground: "#5c6370", fontStyle: "italic" } }],
    semanticTokenColors: { parameter: { foreground: "#c9a227" } },
};

export function pirateCrowText(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...PIRATE_CROW, ...overrides });
}

export interface ZipFile {
    readonly name: string;
    readonly text: string;
    readonly stored?: boolean;
}

// A minimal archive: local headers, then a central directory, then the end record.
export function buildZip(files: readonly ZipFile[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name);
        const raw = Buffer.from(file.text);
        const method = file.stored === true ? 0 : 8;
        const data = method === 0 ? raw : deflateRawSync(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

export function manifestText(themes: readonly { label: string; uiTheme?: string; path: string }[], extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ name: "pirate-crow-pack", displayName: "Pirate Crow Pack", contributes: { themes }, ...extra });
}
