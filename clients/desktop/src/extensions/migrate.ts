import { readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseImportedTheme } from "../../../ui/src/theme/imported.ts";
import { MAX_THEME_BYTES, ThemeStore } from "../theme-store.ts";
import { savedThemeExtensionId, stageSavedTheme } from "./saved-theme.ts";
import type { ExtensionStore } from "./store.ts";

export interface Migration {
    // Themes that are now in an extension of their own.
    readonly moved: number;
    // Theme files left where they were, because they would not read or the extension could not be installed.
    readonly kept: number;
}

function readSaved(path: string, slug: string): { readonly name: string } | undefined {
    try {
        if (statSync(path).size > MAX_THEME_BYTES) return undefined;
        const theme = parseImportedTheme(JSON.parse(readFileSync(path, "utf8")));
        return theme !== undefined && theme.slug === slug ? { name: theme.name } : undefined;
    } catch {
        return undefined;
    }
}

// Moves each theme saved under machine/desktop/themes into an extension named `imported.<slug>`. The extension is
// installed and read back before the old file is removed, so a failure leaves the file in place and the theme usable.
// Running it again finishes whatever an earlier run left.
export function migrateSavedThemes(store: ExtensionStore, savedDirectory: string): Migration {
    const saved = new ThemeStore(savedDirectory);
    let moved = 0;
    let kept = 0;
    for (const slug of saved.slugs()) {
        const file = join(savedDirectory, `${slug}.json`);
        if (store.installedVersion(savedThemeExtensionId(slug)) !== undefined) {
            rmSync(file, { force: true });
            moved += 1;
            continue;
        }
        const theme = readSaved(file, slug);
        let installed = false;
        if (theme !== undefined) {
            try {
                const staging = stageSavedTheme(store, { slug, name: theme.name }, file, "copy");
                installed = store.commit(staging).ok;
                store.discard(staging);
            } catch {
                installed = false;
            }
        }
        if (installed) {
            rmSync(file, { force: true });
            moved += 1;
        } else {
            kept += 1;
        }
    }
    try {
        rmdirSync(savedDirectory);
    } catch {
        // The folder still holds files that were kept, or is already gone.
    }
    return { moved, kept };
}
