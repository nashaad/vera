import type { ImportedTheme } from "../../../ui/src/theme/imported.ts";
import type { LoadedTheme } from "./chain.ts";
import { classifyType, mapColors } from "./color-map.ts";
import { ThemeRefusal } from "./refusal.ts";

const MAX_NAME_CHARS = 120;
const MAX_SLUG_CHARS = 64;

export interface ThemeOrigin {
    // What the person calls the theme: the extension's label for it, or the file's own name.
    readonly name: string;
    // Where it came from, shown beside the theme.
    readonly source: string;
    // The extension manifest's uiTheme, which stands in when the file has no type.
    readonly uiTheme?: string;
}

// The theme file's name on disk, so importing the same theme again replaces its file.
export function slugOf(name: string): string {
    const slug = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .slice(0, MAX_SLUG_CHARS)
        .replace(/-+$/, "");
    return slug.length === 0 ? "theme" : slug;
}

export function cleanName(name: string): string {
    return name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
}

export function convertTheme(loaded: LoadedTheme, origin: ThemeOrigin): ImportedTheme {
    const name = cleanName(origin.name);
    if (name.length === 0) throw new ThemeRefusal("The theme has no name.");
    const type = classifyType(loaded.type, origin.uiTheme, loaded.colors);
    const mapped = mapColors(loaded.colors, type);
    if (mapped.used === 0) {
        throw new ThemeRefusal(
            `"${name}" sets none of the colors Vera reads, such as editor.background or sideBar.background, so it is not a VS Code color theme.`,
        );
    }
    return {
        version: 1,
        slug: slugOf(name),
        name,
        type,
        source: origin.source,
        colors: mapped.colors,
        values: mapped.shadow === undefined ? {} : { shadow: mapped.shadow },
        tokenColors: loaded.tokenColors,
        semanticTokenColors: loaded.semanticTokenColors,
    };
}
