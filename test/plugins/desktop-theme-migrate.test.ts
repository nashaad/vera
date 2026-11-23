import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateSavedThemes } from "../../clients/desktop/src/extensions/migrate.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { migratePluginsIn } from "../../src/plugins/migrate.ts";

test("host plugin migration moves a desktop-migrated legacy theme into a plugin", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-plugin-theme-"));
    const signals = spyOn(process, "kill").mockImplementation(() => {
        throw new Error("Unexpected process signal");
    });
    try {
        const themes = themesDirectory(home);
        mkdirSync(themes, { recursive: true });
        writeFileSync(join(themes, "legacy-crow.json"), JSON.stringify({
            version: 1,
            slug: "legacy-crow",
            name: "Legacy Crow",
            type: "dark",
            source: "Extension crow.pack",
            colors: { surface: "#202830" },
            values: {},
            tokenColors: [],
            semanticTokenColors: {},
        }));
        const store = new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)));
        expect(migrateSavedThemes(store, themes)).toEqual({ moved: 1, kept: 0 });

        const outcome = migratePluginsIn(home);
        expect(outcome.report.failures).toEqual([]);
        expect(existsSync(join(extensionsDirectory(home), "imported.legacy-crow"))).toBe(false);
        expect(existsSync(`${extensionsDirectory(home)}.pre-plugins`)).toBe(true);
        expect(store.entries()).toContainEqual(expect.objectContaining({ id: "imported.legacy-crow" }));
        expect(store.pluginOwner("imported.legacy-crow")).toBe("imported.legacy-crow");
        expect(signals).not.toHaveBeenCalled();
    } finally {
        signals.mockRestore();
        rmSync(home, { recursive: true, force: true });
    }
});
