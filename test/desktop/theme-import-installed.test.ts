import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { scanInstalledThemes } from "../../clients/desktop/src/theme-import/installed.ts";
import { extensionRoots } from "../../clients/desktop/src/theme-import/roots.ts";
import { runThemeTask } from "../../clients/desktop/src/theme-import/run-task.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { manifestText, pirateCrowText, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function extension(root: string, folder: string, themes: { label: string; uiTheme?: string; path: string }[], files: Record<string, string>, extra: Record<string, unknown> = {}): void {
    writeText(join(root, folder, "package.json"), manifestText(themes, extra));
    for (const [name, text] of Object.entries(files)) writeText(join(root, folder, name), text);
}

function fixtureRoot(): string {
    const root = scratchDirectory();
    extension(root, "crow.pirate-crow-pack-1.0.0", [
        { label: "Pirate Crow Night", uiTheme: "vs-dark", path: "./themes/night.json" },
        { label: "Pirate Crow Day", uiTheme: "vs", path: "./themes/day.json" },
    ], {
        "themes/night.json": pirateCrowText({ type: undefined }),
        "themes/day.json": JSON.stringify({ colors: { "editor.background": "#fbf7ee" } }),
    });
    extension(root, "crow.pirate-crow-pack-0.9.0", [{ label: "Old Crow", path: "./old.json" }], { "old.json": pirateCrowText() });
    extension(root, "crow.snippets-2.0.0", [], {}, { contributes: { snippets: [] } });
    writeText(join(root, "stray-file.txt"), "not a folder");
    writeText(join(root, ".obsolete"), JSON.stringify({ "crow.pirate-crow-pack-0.9.0": true }));
    return root;
}

test("@core installed VS Code themes are listed by extension, skipping replaced versions and extensions without themes", async () => {
    const scan = await scanInstalledThemes([fixtureRoot()]);
    expect(scan.cut).toBe(false);
    expect(scan.themes.map((theme) => `${theme.extension}: ${theme.label}`)).toEqual([
        "Pirate Crow Pack: Pirate Crow Day",
        "Pirate Crow Pack: Pirate Crow Night",
    ]);
});

test("a missing extensions folder or an unreadable manifest lists nothing", async () => {
    const root = scratchDirectory();
    writeText(join(root, "crow.broken-1.0.0", "package.json"), "{ \"contributes\": { \"themes\": ");
    const scan = await scanInstalledThemes([join(root, "absent"), root]);
    expect(scan).toEqual({ themes: [], cut: false });
});

test("the list is cut at the limit and says so", async () => {
    const root = scratchDirectory();
    const themes = Array.from({ length: 200 }, (_, index) => ({ label: `Crow ${index}`, path: `./t${index}.json` }));
    for (const folder of ["crow.a-1.0.0", "crow.b-1.0.0"]) extension(root, folder, themes, {});
    const scan = await scanInstalledThemes([root]);
    expect(scan.themes).toHaveLength(300);
    expect(scan.cut).toBe(true);
});

test("the roots are the user's VS Code folder, plus the app's own themes on macOS", () => {
    expect(extensionRoots("linux")).toHaveLength(1);
    expect(extensionRoots("linux")[0]).toEndWith(join(".vscode", "extensions"));
    expect(extensionRoots("darwin")).toHaveLength(2);
    expect(extensionRoots("darwin")[1]).toContain("Visual Studio Code.app");
});

test("@core the service imports an installed theme by the key of the last list and saves it under the home", async () => {
    const home = scratchDirectory();
    const changes: string[] = [];
    const service = new ThemeService(themesDirectory(home), runThemeTask, [fixtureRoot()], () => changes.push("changed"));
    const listed = await service.listInstalled();
    expect(listed.ok && listed.themes.map((theme) => [theme.key, theme.label])).toEqual([
        ["installed-0", "Pirate Crow Day"],
        ["installed-1", "Pirate Crow Night"],
    ]);
    const result = await service.importInstalled("installed-1");
    expect(result.ok && result.imported.map((theme) => [theme.name, theme.source])).toEqual([["Pirate Crow Night", "Extension Pirate Crow Pack"]]);
    expect(result.ok && result.themes.map((theme) => theme.slug)).toEqual(["pirate-crow-night"]);
    expect(service.has("pirate-crow-night")).toBe(true);
    expect(changes).toEqual(["changed"]);
    expect(service.themes().map((theme) => theme.colors.surface)).toEqual(["#10131a"]);
});

test("@core the service refuses a key it did not list, so a request cannot name a path", async () => {
    const service = new ThemeService(themesDirectory(scratchDirectory()), runThemeTask, [fixtureRoot()]);
    expect(await service.importInstalled("installed-0")).toEqual({ ok: false, reason: "That theme is not in the list. Open the list again." });
    await service.listInstalled();
    for (const key of ["../../etc/passwd", "installed-9", "/Users/crow/theme.json", ""]) expect((await service.importInstalled(key)).ok).toBe(false);
});

test("the service reports a theme that has gone missing since the list was made", async () => {
    const root = fixtureRoot();
    const service = new ThemeService(themesDirectory(scratchDirectory()), runThemeTask, [root]);
    await service.listInstalled();
    writeText(join(root, "crow.pirate-crow-pack-1.0.0", "themes", "night.json"), "{");
    const result = await service.importInstalled("installed-1");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/not valid JSON/);
});

test("the service loads themes saved earlier and notices a file added by hand", async () => {
    const home = scratchDirectory();
    const service = new ThemeService(themesDirectory(home), runThemeTask, []);
    const changes: string[] = [];
    const watching = new ThemeService(themesDirectory(home), runThemeTask, [], () => changes.push("changed"));
    expect(service.load()).toEqual([]);
    expect((await service.importFile(writeText(join(scratchDirectory(), "crow.json"), pirateCrowText()))).ok).toBe(true);
    expect(watching.load().map((theme) => theme.name)).toEqual(["Pirate Crow"]);
    expect(watching.load()).toHaveLength(1);
    expect(changes).toEqual(["changed"]);
});
