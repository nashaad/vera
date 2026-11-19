import { existsSync, statSync } from "node:fs";

export interface FilePathMention {
    readonly text: string;
    readonly path: string;
}

export const FILE_PATH_PATTERN = /(?:^|\s)("\/[^"\n]+"|'\/[^'\n]+'|\/(?:\\.|[^\s])+)/g;

export function decodeFilePath(raw: string): string {
    return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw.replace(/\\(.)/g, "$1");
}

export function filePathMentions(text: string): readonly FilePathMention[] {
    const found: FilePathMention[] = [];
    const line = text.trim();
    if (line.startsWith("/") && !line.includes("\n") && existsSync(line) && !imageFile(line)) return [{ text: line, path: line }];
    let checked = 0;
    for (const match of text.matchAll(FILE_PATH_PATTERN)) {
        const raw = match[1]!;
        const path = decodeFilePath(raw);
        if (found.some((item) => item.path === path)) continue;
        if (++checked > 64) break;
        if (!existsSync(path) || imageFile(path)) continue;
        found.push({ text: raw, path });
        if (found.length > 8) break;
    }
    return found;
}

function imageFile(path: string): boolean {
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path)) return false;
    try { return statSync(path).isFile(); } catch { return false; }
}
