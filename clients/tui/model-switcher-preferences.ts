import {
    loadModelPickerPreferences,
    saveModelPickerPreferences,
} from "./theme-preference.ts";
import type { TuiModelSwitcherScope } from "./model-switcher.ts";

export function loadSwitcherScopePreference(path?: string): TuiModelSwitcherScope {
    return loadModelPickerPreferences(path).scope === "all" ? "all" : "favorites";
}

export function saveSwitcherScopePreference(
    scope: TuiModelSwitcherScope,
    path?: string,
): void {
    const preferences = loadModelPickerPreferences(path);
    saveModelPickerPreferences({
        ...preferences,
        scope: scope === "all" ? "all" : "pool",
    }, path);
}
