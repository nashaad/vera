import { readdirSync } from "node:fs";
import { join } from "node:path";

import { parseImportedTheme, summaryOf, type ImportedTheme, type ImportedThemeSummary } from "../../ui/src/theme/imported.ts";
import { isThemeSlug } from "../../ui/src/theme/tokens.ts";
import { JsonFileStore } from "./json-file-store.ts";

// A saved theme keeps its token rules, which can be large.
export const MAX_THEME_BYTES = 2 * 1024 * 1024;
export const MAX_SAVED_THEMES = 100;

const THEME_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.json$/;

export function themesDirectory(home: string): string {
    return join(home, "machine", "desktop", "themes");
}

// Imported themes, one JSON file each under the desktop's themes folder. The host never reads them.
export class ThemeStore {
    constructor(private readonly directory: string) {}

    private storeFor(slug: string): JsonFileStore<ImportedTheme> {
        return new JsonFileStore<ImportedTheme>(join(this.directory, `${slug}.json`), MAX_THEME_BYTES, (value) => {
            const theme = parseImportedTheme(value);
            return theme !== undefined && theme.slug === slug ? theme : undefined;
        });
    }

    slugs(): readonly string[] {
        let names: string[];
        try {
            names = readdirSync(this.directory);
        } catch {
            return [];
        }
        const slugs: string[] = [];
        for (const name of names.sort()) {
            const slug = THEME_FILE.exec(name)?.[1];
            if (slug !== undefined) slugs.push(slug);
        }
        return slugs.slice(0, MAX_SAVED_THEMES);
    }

    // What the page needs to draw each theme. Each file is read one at a time and its token rules are dropped.
    list(): readonly ImportedThemeSummary[] {
        const summaries: ImportedThemeSummary[] = [];
        for (const slug of this.slugs()) {
            const theme = this.storeFor(slug).load();
            if (theme !== undefined) summaries.push(summaryOf(theme));
        }
        return summaries.sort((a, b) => a.name.localeCompare(b.name));
    }

    has(slug: string): boolean {
        return isThemeSlug(slug) && this.slugs().includes(slug);
    }

    // Replaces the file of the same name. False when the file could not be written.
    save(theme: ImportedTheme): boolean {
        return this.storeFor(theme.slug).save(theme);
    }
}
