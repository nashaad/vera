import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import type { ImportedTheme } from "../../clients/ui/src/theme/imported.ts";
import { MAX_EXTENSIONS } from "../../clients/desktop/src/extensions/limits.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { ExtensionCommandService, type CommandHost } from "../../clients/desktop/src/extension-commands/service.ts";
import { parseCommandReply, parseCommandTask, type CommandReply, type CommandTask } from "../../clients/desktop/src/extension-commands/task-protocol.ts";
import { scanInstalledThemes } from "../../extensions/vscode-theme-import/installed.ts";
import { IMPORT_COMMAND, INSTALLED_COMMAND, runCommandTask } from "../../extensions/vscode-theme-import/run-task.ts";
import { extensionRoots } from "../../extensions/vscode-theme-import/roots.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { manifestText, pirateCrowText, removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

interface Commands {
    readonly home: string;
    readonly store: ExtensionStore;
    readonly themes: ThemeService;
    readonly service: ExtensionCommandService;
    // The tasks the importer received, as they arrived after the copy.
    readonly sent: CommandTask[];
    // What the file dialog answers with; undefined is a cancel.
    readonly dialog: { path: string | undefined };
}

// The importer's committed manifest in a scratch included folder, so the commands resolve as they do in the app.
function includedImporter(): string {
    const included = scratchDirectory();
    const folder = join(included, "vera.vscode-theme-import");
    writeText(join(folder, "vera.desktop.json"), readFileSync(join(import.meta.dir, "..", "..", "extensions", "vscode-theme-import", "vera.desktop.json"), "utf8"));
    writeText(join(folder, "theme-import.cjs"), "");
    return included;
}

// Every task reaches the importer as a copy and keeps nothing between runs, as it does in its own process.
function commandsOver(home: string, roots: string[], onChange?: () => void): Commands {
    const store = new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)), includedImporter());
    const themes = new ThemeService(store, themesDirectory(home), onChange);
    const sent: CommandTask[] = [];
    const dialog: { path: string | undefined } = { path: undefined };
    const host: CommandHost = {
        target: (command) => store.commandTarget(command),
        run: async (_target, task): Promise<CommandReply> => {
            const received = parseCommandTask(structuredClone(task));
            if (received === undefined) throw new Error("The task did not read.");
            sent.push(received);
            const reply = parseCommandReply(JSON.parse(JSON.stringify(await runCommandTask(received, roots))));
            if (reply === undefined) throw new Error("The reply did not read.");
            return reply;
        },
        chooseFile: async () => dialog.path,
    };
    return { home, store, themes, sent, dialog, service: new ExtensionCommandService(host, themes) };
}

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

test("@core a command lists installed themes by key, and the key imports one as a desktop extension", async () => {
    const home = scratchDirectory();
    const changes: string[] = [];
    const { service, themes, store } = commandsOver(home, [fixtureRoot()], () => changes.push("changed"));
    const listed = await service.run(INSTALLED_COMMAND);
    expect(listed.ok && listed.kind === "pick" && listed.title).toBe("Themes installed in VS Code");
    expect(listed.ok && listed.kind === "pick" && listed.items).toEqual([
        { key: "pick-0", label: "Pirate Crow Day", detail: "Pirate Crow Pack" },
        { key: "pick-1", label: "Pirate Crow Night", detail: "Pirate Crow Pack" },
    ]);
    const result = await service.run(INSTALLED_COMMAND, "pick-1");
    expect(result.ok && result.kind === "themes" && result.imported.map((theme) => [theme.name, theme.source])).toEqual([["Pirate Crow Night", "Extension Pirate Crow Pack"]]);
    expect(result.ok && result.kind === "themes" && result.themes.map((theme) => theme.slug)).toEqual(["pirate-crow-night"]);
    expect(themes.has("pirate-crow-night")).toBe(true);
    expect(changes).toEqual(["changed"]);
    expect(store.themes().map((theme) => theme.colors.surface)).toEqual(["#10131a"]);
    expect(existsSync(join(extensionsDirectory(home), "imported.pirate-crow-night", "vera.desktop.json"))).toBe(true);
    expect(existsSync(themesDirectory(home))).toBe(false);
});

test("@core the window never sees what the list holds, and main hands the value back to the task as it came", async () => {
    const root = fixtureRoot();
    const { service, sent } = commandsOver(scratchDirectory(), [root]);
    const listed = await service.run(INSTALLED_COMMAND);
    expect(JSON.stringify(listed)).not.toContain(root);
    expect(JSON.stringify(listed)).not.toContain("night.json");
    await service.run(INSTALLED_COMMAND, "pick-1");
    expect(sent.map((task) => Object.keys(task).sort())).toEqual([["command"], ["command", "pick"]]);
    expect(JSON.stringify(sent[1]?.pick)).toContain(join(root, "crow.pirate-crow-pack-1.0.0"));
});

test("@core the next list replaces the last, so an old key is not read against the new one", async () => {
    const roots = [fixtureRoot()];
    const { service } = commandsOver(scratchDirectory(), roots);
    await service.run(INSTALLED_COMMAND);
    const single = scratchDirectory();
    extension(single, "crow.single-1.0.0", [{ label: "Lone Crow", path: "./lone.json" }], { "lone.json": pirateCrowText({ name: "Lone Crow" }) });
    roots[0] = single;
    const again = await service.run(INSTALLED_COMMAND);
    expect(again.ok && again.kind === "pick" && again.items.map((item) => item.label)).toEqual(["Lone Crow"]);
    expect(await service.run(INSTALLED_COMMAND, "pick-1")).toEqual({ ok: false, reason: "That item is not in the list. Open the list again." });
    const picked = await service.run(INSTALLED_COMMAND, "pick-0");
    expect(picked.ok && picked.kind === "themes" && picked.imported.map((theme) => theme.name)).toEqual(["Lone Crow"]);
});

test("@core a key the last list did not hold is refused, so a request cannot name a path", async () => {
    const { service, sent } = commandsOver(scratchDirectory(), [fixtureRoot()]);
    const stale = { ok: false, reason: "That item is not in the list. Open the list again." } as const;
    expect(await service.run(INSTALLED_COMMAND, "pick-0")).toEqual(stale);
    await service.run(INSTALLED_COMMAND);
    for (const key of ["../../etc/passwd", "pick-9", "/Users/crow/theme.json", "", "pick-00000", "pick--1"]) expect(await service.run(INSTALLED_COMMAND, key)).toEqual(stale);
    expect(sent).toHaveLength(1);
    expect(await service.run(IMPORT_COMMAND, "pick-0")).toEqual(stale);
});

test("a theme that has gone missing since the list was made is reported", async () => {
    const root = fixtureRoot();
    const { service } = commandsOver(scratchDirectory(), [root]);
    await service.run(INSTALLED_COMMAND);
    writeText(join(root, "crow.pirate-crow-pack-1.0.0", "themes", "night.json"), "{");
    const result = await service.run(INSTALLED_COMMAND, "pick-1");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/not valid JSON/);
});

test("a command that is missing, or whose extension is not included, runs nothing", async () => {
    const home = scratchDirectory();
    const store = new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)));
    const themes = new ThemeService(store, themesDirectory(home));
    const host: CommandHost = {
        target: (command) => store.commandTarget(command),
        run: async () => { throw new Error("A task must not start."); },
        chooseFile: async () => { throw new Error("A dialog must not open."); },
    };
    const service = new ExtensionCommandService(host, themes);
    expect(await service.run(IMPORT_COMMAND)).toEqual({ ok: false, reason: "Vera could not run that command." });
    expect(await service.run("vera.unknown.command")).toEqual({ ok: false, reason: "Vera could not run that command." });
});

test("@core a file command asks for a file with the manifest's filter, and cancelling runs nothing and reports nothing", async () => {
    const { service, store, sent, dialog } = commandsOver(scratchDirectory(), []);
    expect(store.commandTarget(IMPORT_COMMAND)?.file).toEqual({ label: "VS Code themes", extensions: ["json", "jsonc", "vsix"] });
    expect(store.commandTarget(INSTALLED_COMMAND)?.file).toBeUndefined();
    const cancelled = await service.run(IMPORT_COMMAND);
    expect(cancelled).toEqual({ ok: true, kind: "themes", imported: [], themes: [], skipped: [] });
    expect(sent).toEqual([]);
    dialog.path = writeText(join(scratchDirectory(), "crow.json"), pirateCrowText());
    const result = await service.run(IMPORT_COMMAND);
    expect(result.ok && result.kind === "themes" && result.imported.map((theme) => theme.name)).toEqual(["Pirate Crow"]);
    expect(sent).toEqual([{ command: IMPORT_COMMAND, file: dialog.path }]);
});

test("the themes saved earlier are loaded, and a theme installed by another service is noticed", async () => {
    const home = scratchDirectory();
    const { service, dialog } = commandsOver(home, []);
    const changes: string[] = [];
    const watching = commandsOver(home, [], () => changes.push("changed"));
    expect(watching.themes.load()).toEqual([]);
    dialog.path = writeText(join(scratchDirectory(), "crow.json"), pirateCrowText());
    expect((await service.run(IMPORT_COMMAND)).ok).toBe(true);
    expect(watching.themes.load().map((theme) => theme.name)).toEqual(["Pirate Crow"]);
    expect(watching.themes.load()).toHaveLength(1);
    expect(changes).toEqual(["changed"]);
});

async function converted(...names: string[]): Promise<ImportedTheme[]> {
    const themes: ImportedTheme[] = [];
    for (const name of names) {
        const reply = await runCommandTask({ command: IMPORT_COMMAND, file: writeText(join(scratchDirectory(), "theme.json"), pirateCrowText({ name })) });
        if (reply.kind !== "themes") throw new Error("The fixture theme did not import.");
        themes.push(...reply.themes);
    }
    return themes;
}

function themeServiceOver(home: string): ThemeService {
    return new ThemeService(new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home))), themesDirectory(home));
}

test("@core each theme a task sends back is installed as its own extension, and a refusal installs nothing", async () => {
    const home = scratchDirectory();
    const service = themeServiceOver(home);
    const result = service.install(await converted("Crow Night", "Crow Day"), ["Lost Crow: The .vsix has no file."]);
    expect(result.ok && result.kind === "themes" && result.imported.map((theme) => theme.slug)).toEqual(["crow-night", "crow-day"]);
    expect(result.ok && result.kind === "themes" && result.skipped).toEqual(["Lost Crow: The .vsix has no file."]);
    expect(readdirSync(extensionsDirectory(home)).sort()).toEqual(["imported.crow-day", "imported.crow-night"]);
    expect(service.themes().map((theme) => theme.name)).toEqual(["Crow Day", "Crow Night"]);

    const empty = themeServiceOver(scratchDirectory());
    expect(empty.install([], [])).toEqual({ ok: false, reason: "Vera could not install that theme." });
});

test("@core a refusal from the task reaches the window as its reason, and nothing is installed", async () => {
    const home = scratchDirectory();
    const store = new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)), includedImporter());
    const host: CommandHost = {
        target: (command) => store.commandTarget(command),
        run: async () => ({ kind: "refused", reason: "The file is not valid JSON." }),
        chooseFile: async () => "/ignored.json",
    };
    const service = new ExtensionCommandService(host, new ThemeService(store, themesDirectory(home)));
    expect(await service.run(IMPORT_COMMAND)).toEqual({ ok: false, reason: "The file is not valid JSON." });
    expect(existsSync(extensionsDirectory(home))).toBe(false);
});

test("@core at the extension limit a new theme is refused with the extension wording and the others still land", async () => {
    const home = scratchDirectory();
    const root = extensionsDirectory(home);
    for (let index = 0; index < MAX_EXTENSIONS - 1; index += 1) {
        writeText(join(root, `bare-${index}`, "vera.desktop.json"), JSON.stringify({ id: `bare-${index}`, version: "1.0.0", engine: DESKTOP_ENGINE }));
    }
    const service = themeServiceOver(home);
    const result = service.install(await converted("Crow Night", "Crow Day"), []);
    expect(result.ok && result.kind === "themes" && result.imported.map((theme) => theme.slug)).toEqual(["crow-night"]);
    expect(result.ok && result.kind === "themes" && result.skipped).toEqual([`Crow Day: Vera keeps at most ${MAX_EXTENSIONS} desktop extensions. Remove one first.`]);
    expect(service.install(await converted("Crow Dusk"), [])).toEqual({ ok: false, reason: `Vera keeps at most ${MAX_EXTENSIONS} desktop extensions. Remove one first.` });
});
