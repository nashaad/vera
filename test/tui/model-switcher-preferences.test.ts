import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelPickerPreferences, saveModelPickerPreferences } from "../../clients/tui/theme-preference.ts";
import {
    loadSwitcherScopePreference,
    saveSwitcherScopePreference,
} from "../../clients/tui/model-switcher-preferences.ts";

test("@core switcher scope persists in the real model picker store", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-model-switcher-preferences-"));
    const path = join(directory, "tui.json");
    try {
        saveModelPickerPreferences({ view: "detailed", scope: "all", sort: "price" }, path);
        expect(loadSwitcherScopePreference(path)).toBe("all");

        saveSwitcherScopePreference("favorites", path);
        expect(loadModelPickerPreferences(path)).toEqual({
            view: "detailed",
            scope: "pool",
            sort: "price",
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
