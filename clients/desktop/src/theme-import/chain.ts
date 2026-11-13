import { parseJsonc } from "./jsonc.ts";
import { ThemeRefusal } from "./refusal.ts";
import type { ThemeSource } from "./source.ts";

const MAX_INCLUDE_DEPTH = 8;

export interface LoadedTheme {
    // The theme's own `name`, when the leaf file has one.
    readonly name: string | undefined;
    readonly type: unknown;
    readonly colors: Readonly<Record<string, unknown>>;
    readonly tokenColors: readonly unknown[];
    readonly semanticTokenColors: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileLabel(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

// Reads a theme and the files it includes, merged as VS Code merges them: an including file's colors win,
// its token rules come after the included ones, and its semantic rules replace those of the same name.
export function loadTheme(source: ThemeSource, path: string): LoadedTheme {
    return load(source, path, [path]);
}

function load(source: ThemeSource, path: string, chain: readonly string[]): LoadedTheme {
    const value = parseFile(source, path);
    const own: LoadedTheme = {
        name: typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : undefined,
        type: value.type,
        colors: isRecord(value.colors) ? value.colors : {},
        tokenColors: Array.isArray(value.tokenColors) ? value.tokenColors : [],
        semanticTokenColors: isRecord(value.semanticTokenColors) ? value.semanticTokenColors : {},
    };
    if (value.include === undefined) return own;
    if (typeof value.include !== "string") {
        throw new ThemeRefusal(`"${fileLabel(path)}" has an include that is not a file path.`);
    }
    if (chain.length > MAX_INCLUDE_DEPTH) {
        throw new ThemeRefusal(`"${fileLabel(path)}" includes files nested more than ${MAX_INCLUDE_DEPTH} deep.`);
    }
    const includedPath = source.resolve(path, value.include);
    if (chain.includes(includedPath)) {
        throw new ThemeRefusal(`"${fileLabel(path)}" includes "${fileLabel(includedPath)}", which includes it back.`);
    }
    let base: LoadedTheme;
    try {
        base = load(source, includedPath, [...chain, includedPath]);
    } catch (error) {
        if (!(error instanceof ThemeRefusal) || error.message.startsWith("Included file")) throw error;
        throw new ThemeRefusal(`Included file "${fileLabel(includedPath)}": ${error.message}`);
    }
    return {
        name: own.name,
        type: own.type ?? base.type,
        colors: { ...base.colors, ...own.colors },
        tokenColors: [...base.tokenColors, ...own.tokenColors],
        semanticTokenColors: { ...base.semanticTokenColors, ...own.semanticTokenColors },
    };
}

function parseFile(source: ThemeSource, path: string): Record<string, unknown> {
    const value = parseJsonc(source.read(path));
    if (!isRecord(value)) throw new ThemeRefusal(`"${fileLabel(path)}" is not a theme: it does not hold a JSON object.`);
    return value;
}
