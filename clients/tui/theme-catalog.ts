/** The themes the picker offers: the built-ins, merged with the home's tui-themes.json. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliRenderer } from "@opentui/core";
import { veraProfileDirectory } from "../../src/profile-paths.ts";
import {
    BUILT_IN_TUI_THEMES,
    BUILT_IN_TUI_THEME_PROBLEMS,
    FALLBACK_TUI_THEME,
    parseTuiThemeEntry,
    resolveSystemTuiTheme,
    type TuiTheme,
    type TuiThemeEntry,
    type TuiThemeName,
} from "./theme.ts";

export interface TuiThemeCatalog {
    readonly entries: readonly TuiThemeEntry[];
    readonly problems: readonly string[];
}

export interface TuiThemeOption {
    readonly name: TuiThemeName;
    readonly label: string;
    readonly description: string;
}

export const USER_TUI_THEMES_FILE = "tui-themes.json";

export function userTuiThemesPath(): string {
    return join(veraProfileDirectory(), USER_TUI_THEMES_FILE);
}

export function loadTuiThemeCatalog(path = userTuiThemesPath()): TuiThemeCatalog {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { entries: BUILT_IN_TUI_THEMES, problems: BUILT_IN_TUI_THEME_PROBLEMS };
        }
        return { entries: BUILT_IN_TUI_THEMES, problems: [...BUILT_IN_TUI_THEME_PROBLEMS, `${path} could not be read: ${errorMessage(error)}`] };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { entries: BUILT_IN_TUI_THEMES, problems: [...BUILT_IN_TUI_THEME_PROBLEMS, `${path} is not valid JSON: ${errorMessage(error)}`] };
    }
    return mergeUserTuiThemes(raw, path);
}

/** A user theme replaces a built-in of the same name in place; new names follow the built-ins in file order. */
export function mergeUserTuiThemes(raw: unknown, source: string): TuiThemeCatalog {
    const themes = isRecord(raw) ? raw["themes"] : undefined;
    if (!isRecord(themes)) {
        return { entries: BUILT_IN_TUI_THEMES, problems: [...BUILT_IN_TUI_THEME_PROBLEMS, `${source}: expected {"themes": {...}}`] };
    }
    const entries: TuiThemeEntry[] = [...BUILT_IN_TUI_THEMES];
    const problems: string[] = [...BUILT_IN_TUI_THEME_PROBLEMS];
    for (const [name, value] of Object.entries(themes)) {
        const parsed = parseTuiThemeEntry(name, value, entries);
        if (typeof parsed === "string") {
            problems.push(`${source}: theme "${name}" skipped: ${parsed}`);
            continue;
        }
        const index = entries.findIndex((entry) => entry.name === name);
        if (index === -1) {
            entries.push(parsed);
        } else {
            entries[index] = parsed;
        }
    }
    return { entries, problems };
}

let active: TuiThemeCatalog | undefined;

export function activeTuiThemeCatalog(): TuiThemeCatalog {
    active ??= loadTuiThemeCatalog();
    return active;
}

export function reloadTuiThemeCatalog(path = userTuiThemesPath()): TuiThemeCatalog {
    active = loadTuiThemeCatalog(path);
    return active;
}

/** Picker order is catalog order, with System placed after the default (first when the default is broken). */
export function tuiThemeOptions(
    catalog = activeTuiThemeCatalog(),
): readonly TuiThemeOption[] {
    const options: TuiThemeOption[] = [];
    if (!catalog.entries.some((entry) => entry.name === "default")) {
        options.push({ name: "system", label: "System", description: "inherit terminal colors" });
    }
    for (const entry of catalog.entries) {
        options.push({ name: entry.name, label: entry.label, description: entry.description });
        if (entry.name === "default") {
            options.push({ name: "system", label: "System", description: "inherit terminal colors" });
        }
    }
    return options;
}

export function tuiThemeSwatch(
    name: TuiThemeName,
    catalog = activeTuiThemeCatalog(),
): readonly string[] | undefined {
    const theme = catalog.entries.find((entry) => entry.name === name)?.theme;
    return theme === undefined
        ? undefined
        : [theme.accent, theme.notice, theme.success, theme.text];
}

/** A name that is missing or was skipped as broken falls back to Orng. */
export async function resolveTuiTheme(
    renderer: Pick<CliRenderer, "getPalette">,
    name: TuiThemeName = "default",
    catalog = activeTuiThemeCatalog(),
): Promise<TuiTheme> {
    if (name === "system") {
        return resolveSystemTuiTheme(renderer);
    }
    return catalog.entries.find((entry) => entry.name === name)?.theme ?? FALLBACK_TUI_THEME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
