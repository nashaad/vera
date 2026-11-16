import type { CommandRefusal, CommandThemesDone } from "../protocol/extension-commands.ts";
import { switchTheme } from "./activate.ts";
import { parseImportedSummaries } from "./imported.ts";
import { setImportedThemes } from "./imported-registry.ts";
import { importedThemeId } from "./tokens.ts";

export interface ImportReport {
    readonly ok: boolean;
    // A sentence for the person, shown beside the control or as a toast.
    readonly message: string;
}

export const UNAVAILABLE: ImportReport = { ok: false, message: "Importing a theme needs the desktop app. Your theme is unchanged." };
export const FAILED: ImportReport = { ok: false, message: "Vera could not import that theme. Your theme is unchanged." };

// Saves what the shell imported, then switches to the first theme of the import.
// Undefined when the person closed the picker without choosing.
export function reportImport(result: CommandThemesDone | CommandRefusal): ImportReport | undefined {
    if (!result.ok) return { ok: false, message: `${result.reason} Your theme is unchanged.` };
    const first = result.imported[0];
    if (first === undefined) return undefined;
    setImportedThemes(parseImportedSummaries(result.themes));
    switchTheme(importedThemeId(first.slug));
    const extra = result.imported.length - 1;
    const base = extra === 0
        ? `Imported "${first.name}" and switched to it.`
        : `Imported ${result.imported.length} themes and switched to "${first.name}".`;
    const skipped = result.skipped.length === 0 ? "" : ` Not imported: ${result.skipped.join("; ")}`;
    return { ok: true, message: `${base}${skipped}` };
}
