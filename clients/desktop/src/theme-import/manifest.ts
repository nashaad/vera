import { parseJsonc } from "./jsonc.ts";
import { ThemeRefusal } from "./refusal.ts";

const MAX_THEMES_PER_EXTENSION = 200;
const NLS_REFERENCE = /^%(.+)%$/;

export interface ManifestTheme {
    readonly label: string;
    readonly uiTheme: string | undefined;
    // The theme file's path as the manifest writes it, relative to the extension folder.
    readonly path: string;
}

export interface ThemeManifest {
    readonly extension: string;
    readonly themes: readonly ManifestTheme[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A label can be a %key% reference that package.nls.json fills in.
function resolveLabel(value: string, nls: Readonly<Record<string, unknown>>): string {
    const key = NLS_REFERENCE.exec(value)?.[1];
    if (key === undefined) return value;
    const entry = nls[key];
    if (typeof entry === "string") return entry;
    if (isRecord(entry) && typeof entry.message === "string") return entry.message;
    return key;
}

function readNls(text: string | undefined): Readonly<Record<string, unknown>> {
    if (text === undefined) return {};
    try {
        const value = parseJsonc(text);
        return isRecord(value) ? value : {};
    } catch {
        return {};
    }
}

// The color themes an extension's package.json contributes.
export function readManifest(manifestText: string, nlsText?: string): ThemeManifest {
    const manifest = parseJsonc(manifestText);
    if (!isRecord(manifest)) throw new ThemeRefusal("The extension's package.json is not a JSON object.");
    const nls = readNls(nlsText);
    const contributes = isRecord(manifest.contributes) ? manifest.contributes : {};
    const themes: ManifestTheme[] = [];
    for (const entry of Array.isArray(contributes.themes) ? contributes.themes : []) {
        if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0) continue;
        const rawLabel = typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : undefined;
        if (rawLabel === undefined) continue;
        themes.push({
            label: resolveLabel(rawLabel, nls),
            uiTheme: typeof entry.uiTheme === "string" ? entry.uiTheme : undefined,
            path: entry.path,
        });
        if (themes.length >= MAX_THEMES_PER_EXTENSION) break;
    }
    const named = [manifest.displayName, manifest.name].find((value): value is string => typeof value === "string" && value.length > 0);
    return { extension: named === undefined ? "Unnamed extension" : resolveLabel(named, nls), themes };
}
