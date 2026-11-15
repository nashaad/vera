import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runInstallTask } from "../../clients/desktop/src/extension-install/run-task.ts";
import { parseInstallReply, parseInstallTask, type InstallReply, type InstallTask } from "../../clients/desktop/src/extension-install/task-protocol.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionService } from "../../clients/desktop/src/extensions/service.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { runThemeTask } from "../../clients/desktop/src/theme-import/run-task.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { themeFiles, writePackage } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory } from "./theme-fixtures.ts";

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
    const store = new ExtensionStore(extensionsDirectory(home), new ExtensionStateStore(extensionStatePath(home)));
    const themes = new ThemeService(store, themesDirectory(home), runThemeTask);
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
    expect((await themes.importFile(path)).ok).toBe(true);
    expect((await themes.importFile(path)).ok).toBe(true);
    expect(folders(home)).toEqual(["imported.pirate-crow"]);
    expect(existsSync(themesDirectory(home))).toBe(false);
    expect(themes.themes().map((theme) => theme.slug)).toEqual(["pirate-crow"]);
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
