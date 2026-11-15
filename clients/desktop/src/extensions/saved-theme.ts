import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_ENGINE, DESKTOP_MANIFEST_FILENAME } from "../../../ui/src/extensions/manifest.ts";
import type { ImportedTheme } from "../../../ui/src/theme/imported.ts";
import type { ExtensionStore } from "./store.ts";

export const SAVED_THEME_VERSION = "1.0.0";

export function savedThemeExtensionId(slug: string): string {
    return `imported.${slug}`;
}

// Builds an extension folder in staging around one saved theme: the manifest, and the theme under themes/.
// The theme is copied from a saved file, which stays where it was, or written from the theme a task converted.
// Throws when the folder cannot be written.
export function stageSavedTheme(
    store: ExtensionStore,
    theme: { readonly slug: string; readonly name: string },
    content: { readonly file: string } | { readonly theme: ImportedTheme },
): string {
    const staging = store.newStaging();
    try {
        mkdirSync(join(staging, "themes"));
        const path = `themes/${theme.slug}.json`;
        if ("file" in content) copyFileSync(content.file, join(staging, path));
        else writeFileSync(join(staging, path), JSON.stringify(content.theme), { mode: 0o600 });
        writeFileSync(
            join(staging, DESKTOP_MANIFEST_FILENAME),
            `${JSON.stringify({
                id: savedThemeExtensionId(theme.slug),
                version: SAVED_THEME_VERSION,
                engine: DESKTOP_ENGINE,
                contributes: { themes: [{ label: theme.name, path }] },
            })}\n`,
            { mode: 0o600 },
        );
    } catch (error) {
        store.discard(staging);
        throw error;
    }
    return staging;
}
