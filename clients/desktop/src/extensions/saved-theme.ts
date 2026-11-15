import { copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_ENGINE, DESKTOP_MANIFEST_FILENAME } from "../../../ui/src/extensions/manifest.ts";
import type { ExtensionStore } from "./store.ts";

export const SAVED_THEME_VERSION = "1.0.0";

export function savedThemeExtensionId(slug: string): string {
    return `imported.${slug}`;
}

// Builds an extension folder in staging around one saved theme file: the manifest, and the file under themes/.
// A copy leaves the file where it was; a move takes it. Throws when the folder cannot be written.
export function stageSavedTheme(
    store: ExtensionStore,
    theme: { readonly slug: string; readonly name: string },
    file: string,
    how: "copy" | "move",
): string {
    const staging = store.newStaging();
    try {
        mkdirSync(join(staging, "themes"));
        const path = `themes/${theme.slug}.json`;
        if (how === "copy") copyFileSync(file, join(staging, path));
        else renameSync(file, join(staging, path));
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
