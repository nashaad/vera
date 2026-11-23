import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { runInstallTask } from "../../clients/desktop/src/extension-install/run-task.ts";
import { parseInstallReply, parseInstallTask, type InstallReply, type InstallTask } from "../../clients/desktop/src/extension-install/task-protocol.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionService } from "../../clients/desktop/src/extensions/service.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { importThemeFile } from "../../extensions/vscode-theme-import/import-theme.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { themeFiles, writePackage } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

interface Trial {
    readonly home: string;
    readonly service: ExtensionService;
    readonly themes: ThemeService;
    readonly tasks: InstallTask[];
}

// Each task crosses a structured clone, as it does to a task process, and runs with no state of its own.
function trial(run?: (task: InstallTask) => Promise<InstallReply>, onChange?: () => void): Trial {
    const home = scratchDirectory();
    const store = new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)));
    const themes = new ThemeService(store, themesDirectory(home));
    const tasks: InstallTask[] = [];
    const service = new ExtensionService(store, themes, async (task) => {
        tasks.push(task);
        if (run !== undefined) return run(task);
        const parsed = parseInstallTask(structuredClone(task));
        if (parsed === undefined) throw new Error("The task did not read.");
        const reply = parseInstallReply(structuredClone(runInstallTask(parsed)));
        if (reply === undefined) throw new Error("The reply did not read.");
        return reply;
    }, onChange);
    return { home, service, themes, tasks };
}

function folders(home: string): string[] {
    const root = extensionsDirectory(home);
    return existsSync(root) ? readdirSync(root).sort() : [];
}

const CROW = [{ label: "Crow Night", name: "Crow Night" }];

test("@core a package is previewed, then installed on confirm, and its theme is listed", async () => {
    const { home, service, themes } = trial();
    const preview = await service.preview(writePackage(themeFiles("crow.pack", "1.0.0", CROW)));
    if (!preview.ok || preview.preview === undefined) throw new Error("The package did not preview.");
    expect(preview.preview).toMatchObject({ id: "crow.pack", version: "1.0.0", themes: ["Crow Night"], hasMain: false, hasCommands: false });
    expect(preview.preview.replaces).toBeUndefined();
    expect(themes.load()).toEqual([]);
    expect(folders(home)).toHaveLength(1);
    const done = service.confirm(preview.preview.token);
    expect(done.ok && done.extensions.map((entry) => entry.id)).toEqual(["crow.pack"]);
    expect(done.ok && done.themes.map((theme) => theme.name)).toEqual(["Crow Night"]);
    expect(folders(home)).toEqual(["crow.pack"]);
});

test("@core cancel deletes the unpacked package and the token stops working", async () => {
    const { home, service } = trial();
    const preview = await service.preview(writePackage(themeFiles("crow.pack", "1.0.0", CROW)));
    if (!preview.ok || preview.preview === undefined) throw new Error("The package did not preview.");
    service.cancel(preview.preview.token);
    expect(folders(home)).toEqual([]);
    expect(service.confirm(preview.preview.token)).toEqual({ ok: false, reason: "That package is no longer waiting to be installed. Choose it again." });
});

test("@core a token that was not issued, or that a newer preview replaced, installs nothing", async () => {
    const { home, service } = trial();
    expect(service.confirm("guess").ok).toBe(false);
    const first = await service.preview(writePackage(themeFiles("crow.one", "1.0.0", CROW)));
    const second = await service.preview(writePackage(themeFiles("crow.two", "1.0.0", [{ label: "Two", name: "Two" }])));
    if (!first.ok || first.preview === undefined || !second.ok || second.preview === undefined) throw new Error("A package did not preview.");
    expect(service.confirm(first.preview.token).ok).toBe(false);
    expect(folders(home)).toHaveLength(1);
    expect(service.confirm(second.preview.token).ok).toBe(true);
    expect(folders(home)).toEqual(["crow.two"]);
});

test("@core a package that does not read leaves no staging folder, and stale ones are cleared on the next install", async () => {
    const { home, service } = trial();
    const refused = await service.preview(writePackage([{ name: "link", type: "2" }]));
    expect(refused.ok).toBe(false);
    expect(folders(home)).toEqual([]);
    const stale = join(extensionsDirectory(home), ".staging-left-behind");
    await Bun.write(join(stale, "file"), "x");
    const preview = await service.preview(writePackage(themeFiles("crow.pack", "1.0.0", CROW)));
    expect(preview.ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
});

test("a task that crashes or times out refuses the request and leaves no staging folder", async () => {
    const { home, service } = trial(async () => { throw new Error("The task process exited."); });
    expect(await service.preview(writePackage(themeFiles("crow.pack", "1.0.0", CROW)))).toEqual({ ok: false, reason: "Vera could not read that package." });
    expect(folders(home)).toEqual([]);
});

test("@core a newer version replaces the installed one and the preview names what it replaces", async () => {
    const { service } = trial();
    for (const version of ["1.0.0", "2.0.0"]) {
        const preview = await service.preview(writePackage(themeFiles("crow.pack", version, CROW)));
        if (!preview.ok || preview.preview === undefined) throw new Error("The package did not preview.");
        expect(preview.preview.replaces).toBe(version === "1.0.0" ? undefined : "1.0.0");
        expect(service.confirm(preview.preview.token).ok).toBe(true);
    }
    const list = service.list();
    expect(list.ok && list.extensions.map((entry) => entry.version)).toEqual(["2.0.0"]);
});

test("@core turning off and removing an extension reload the themes", async () => {
    const { home, service, themes } = trial();
    const preview = await service.preview(writePackage(themeFiles("crow.pack", "1.0.0", CROW)));
    if (!preview.ok || preview.preview === undefined) throw new Error("The package did not preview.");
    service.confirm(preview.preview.token);
    const off = service.setEnabled("crow.pack", false);
    expect(off.ok && [off.extensions[0]?.enabled, off.themes.length]).toEqual([false, 0]);
    expect(themes.themes()).toEqual([]);
    const on = service.setEnabled("crow.pack", true);
    expect(on.ok && on.themes.length).toBe(1);
    const gone = service.remove("crow.pack");
    expect(gone.ok && [gone.extensions.length, gone.themes.length]).toEqual([0, 0]);
    expect(folders(home)).toEqual([]);
    expect(service.remove("crow.pack")).toEqual({ ok: false, reason: '"crow.pack" is not installed.' });
    expect(service.setEnabled("crow.pack", true)).toEqual({ ok: false, reason: 'Vera could not turn "crow.pack" on.' });
});

test("an included extension is listed as on and the service refuses to turn it off", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    writeText(join(included, "vera.sample", "vera.desktop.json"), JSON.stringify({ id: "vera.sample", version: "1.0.0", engine: DESKTOP_ENGINE }));
    const store = new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)), included);
    const service = new ExtensionService(store, new ThemeService(store, themesDirectory(home)), async () => { throw new Error("no task"); });
    expect(service.setEnabled("vera.sample", false)).toEqual({ ok: false, reason: 'Vera could not turn "vera.sample" off.' });
    const list = service.list();
    expect(list.ok && list.extensions.map((entry) => [entry.id, entry.included, entry.enabled])).toEqual([["vera.sample", true, true]]);
    expect(service.remove("vera.sample")).toEqual({ ok: false, reason: '"vera.sample" is included with Vera and cannot be removed.' });
});

test("the checksum, when given, is passed to the task", async () => {
    const { service, tasks } = trial();
    const path = writePackage(themeFiles("crow.pack", "1.0.0", CROW));
    const refused = await service.preview(path, "0".repeat(64));
    expect(refused).toEqual({ ok: false, reason: "The package does not match its expected checksum." });
    expect(tasks[0]?.sha256).toBe("0".repeat(64));
});

test("a VS Code import becomes a desktop extension, and the same name imported again replaces it", async () => {
    const { home, themes } = trial();
    const path = join(scratchDirectory(), "crow.json");
    await Bun.write(path, JSON.stringify({ name: "Pirate Crow", type: "dark", colors: { "editor.background": "#10131a" } }));
    const converted = importThemeFile(path);
    if (!converted.ok) throw new Error(converted.reason);
    expect(themes.install(converted.themes, converted.skipped).ok).toBe(true);
    expect(themes.install(converted.themes, converted.skipped).ok).toBe(true);
    expect(folders(home)).toEqual(["imported.pirate-crow"]);
    expect(existsSync(themesDirectory(home))).toBe(false);
    expect(themes.themes().map((theme) => theme.slug)).toEqual(["pirate-crow"]);
});

test("worker contributions follow real installs, switches, replacements and removal", async () => {
    const { home, service } = trial();
    const manifest = {
        id: "crow.worker", version: "1.0.0", engine: DESKTOP_ENGINE, main: "main.js",
        contributes: {
            commands: [{ command: "crow.worker.fly", title: "Fly" }],
            keybindings: [{ command: "crow.worker.fly", key: "ctrl+alt+f" }],
        },
    };
    const install = async (source: string) => {
        const path = writePackage([
            { name: "vera.desktop.json", data: JSON.stringify(manifest) },
            { name: "main.js", data: source },
        ]);
        const preview = await service.preview(path);
        if (!preview.ok || preview.preview === undefined) throw new Error("The package did not preview.");
        return service.confirm(preview.preview.token);
    };
    const first = await install("export const revision = 1;");
    expect(first.ok && first.extensions[0]?.worker).toMatchObject({
        main: "main.js", commands: [{ command: "crow.worker.fly" }], keybindings: [{ key: "ctrl+alt+f" }],
    });
    expect(await service.readMain("crow.worker")).toEqual({ ok: true, source: "export const revision = 1;" });
    const off = service.setEnabled("crow.worker", false);
    expect(off.ok && off.extensions[0]?.worker).toBeUndefined();
    expect((await service.readMain("crow.worker")).ok).toBe(false);
    const on = service.setEnabled("crow.worker", true);
    expect(on.ok && on.extensions[0]?.worker).toBeDefined();
    const replacement = await install("export const revision = 2;");
    expect(replacement.ok && replacement.replacedId).toBe("crow.worker");
    expect(await service.readMain("crow.worker")).toEqual({ ok: true, source: "export const revision = 2;" });
    writeText(join(extensionsDirectory(home), "broken", "vera.desktop.json"), "{");
    const listed = service.list();
    expect(listed.ok && listed.diagnostics?.map((item) => item.directory)).toEqual(["broken"]);
    const removed = service.remove("crow.worker");
    expect(removed.ok && removed.extensions).toEqual([]);
    expect((await service.readMain("crow.worker")).ok).toBe(false);
});

test("@core the window hears of each install, switch and removal, and of nothing else", async () => {
    let changes = 0;
    const { service } = trial(undefined, () => { changes += 1; });
    const preview = await service.preview(writePackage(themeFiles("crow.pack", "1.0.0", CROW)));
    if (!preview.ok || preview.preview === undefined) throw new Error("The package did not preview.");
    service.list();
    expect(changes).toBe(0);
    service.confirm(preview.preview.token);
    service.setEnabled("crow.pack", false);
    service.setEnabled("crow.pack", true);
    service.remove("crow.pack");
    expect(changes).toBe(4);
});
