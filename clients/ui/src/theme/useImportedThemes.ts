import { useSyncExternalStore } from "react";

import { importedThemes, subscribeImportedThemes } from "./imported-registry.ts";
import type { ImportedThemeSummary } from "./imported.ts";

export function useImportedThemes(): readonly ImportedThemeSummary[] {
    return useSyncExternalStore(subscribeImportedThemes, importedThemes);
}
