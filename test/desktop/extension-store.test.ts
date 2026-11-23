import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { packageEntries, unpackEntries } from "../../clients/desktop/src/extension-install/unpack.ts";
import { MAX_EXTENSIONS } from "../../clients/desktop/src/extensions/limits.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { MAX_PAGE_SCRIPT_BYTES } from "../../clients/desktop/src/extensions/read-extension.ts";
import { ExtensionStore, themeKey } from "../../clients/desktop/src/extensions/store.ts";
import { tarGzBytes, themeFiles, type FixtureTheme, type TarItem } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function storeFor(home: string, included?: string): ExtensionStore {
    return new ExtensionStore(home, new ExtensionStateStore(extensionStatePath(home)), included);
}

// Unpacks the package into a new staging folder the way the install task does.
function staged(store: ExtensionStore, items: readonly TarItem[]): string {
    const staging = store.newStaging();
    unpackEntries(packageEntries(tarGzBytes(items)), staging);
    return staging;
}

function install(store: ExtensionStore, id: string, version: string, themes: readonly FixtureTheme[]): void {
    const result = store.commit(staged(store, themeFiles(id, version, themes)));
    expect(result.ok).toBe(true);
}

function bareExtension(directory: string, id: string): void {
    writeText(join(directory, id, "vera.desktop.json"), JSON.stringify({ id, version: "1.0.0", engine: DESKTOP_ENGINE }));
}

const CROW = { label: "Crow Night", name: "Crow Night" };

test("@core a committed extension is listed, and its themes are keyed by the extension id", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    install(store, "crow.pack", "1.2.0", [CROW, { label: "Crow Day", name: "Crow Day" }]);
    expect(store.entries()).toEqual([
        { id: "crow.pack", version: "1.2.0", themes: ["Crow Night", "Crow Day"], hasMain: false, hasCommands: false, hasUnavailableContributions: false, commands: [], menus: { appearance: [], theme: [], browser: [] }, included: false, enabled: true },
    ]);
    expect(store.themes().map((theme) => [theme.slug, theme.name])).toEqual([
        ["crow.pack.crow-day", "Crow Day"],
        ["crow.pack.crow-night", "Crow Night"],
    ]);
    expect(readdirSync(extensionsDirectory(home))).toEqual(["crow.pack"]);
});

test("a saved theme in its own extension keeps its plain slug as the key", () => {
    expect(themeKey("imported.pirate-crow", "pirate-crow")).toBe("pirate-crow");
    expect(themeKey("crow.pack", "pirate-crow")).toBe("crow.pack.pirate-crow");
    expect(themeKey("imported.other", "pirate-crow")).toBe("imported.other.pirate-crow");
});

test("@core an extension of the same id replaces the old version whole", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    install(store, "crow.pack", "1.0.0", [CROW, { label: "Crow Day", name: "Crow Day" }]);
    const result = store.commit(staged(store, themeFiles("crow.pack", "2.0.0", [{ label: "Crow Dusk", name: "Crow Dusk" }])));
    expect(result).toEqual({ ok: true, id: "crow.pack", replaced: "1.0.0", replacedId: "crow.pack" });
    expect(store.entries().map((entry) => [entry.version, entry.themes])).toEqual([["2.0.0", ["Crow Dusk"]]]);
    expect(readdirSync(join(extensionsDirectory(home), "crow.pack", "themes"))).toEqual(["crow-dusk.json"]);
    expect(readdirSync(extensionsDirectory(home))).toEqual(["crow.pack"]);
});

test("@core an extension that does not read is refused and leaves the installed version alone", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    install(store, "crow.pack", "1.0.0", [CROW]);
    const broken = staged(store, [{ name: "vera.desktop.json", data: JSON.stringify({ id: "crow.pack", version: "2.0.0", engine: DESKTOP_ENGINE, contributes: { themes: [{ label: "Gone", path: "themes/gone.json" }] } }) }]);
    const result = store.commit(broken);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("is missing or larger than 2 MiB");
    store.discard(broken);
    expect(store.entries()[0]?.version).toBe("1.0.0");
    expect(store.themes()).toHaveLength(1);
});

test("a swap that cannot be made fails and keeps the old version", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    install(store, "crow.pack", "1.0.0", [CROW]);
    const next = staged(store, themeFiles("crow.pack", "2.0.0", [CROW]));
    const root = extensionsDirectory(home);
    chmodSync(root, 0o500);
    try {
        const result = store.commit(next);
        expect(result).toEqual({ ok: false, reason: 'Vera could not install "crow.pack".' });
    } finally {
        chmodSync(root, 0o700);
    }
    expect(store.entries()[0]?.version).toBe("1.0.0");
    expect(store.themes()).toHaveLength(1);
    store.discard(next);
});

test("@core the extension count is capped for a new id but not for a replacement", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    for (let index = 0; index < MAX_EXTENSIONS; index += 1) bareExtension(extensionsDirectory(home), `bare-${index}`);
    expect(store.entries()).toHaveLength(MAX_EXTENSIONS);
    const extra = store.commit(staged(store, themeFiles("one.too-many", "1.0.0", [CROW])));
    expect(extra).toEqual({ ok: false, reason: `Vera keeps at most ${MAX_EXTENSIONS} desktop extensions. Remove one first.` });
    const replacement = staged(store, [{ name: "vera.desktop.json", data: JSON.stringify({ id: "bare-3", version: "2.0.0", engine: DESKTOP_ENGINE }) }]);
    expect(store.commit(replacement).ok).toBe(true);
});

test("@core included extensions are listed to the window, always on, and cannot be turned off, removed or replaced", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    unpackEntries(packageEntries(tarGzBytes(themeFiles("vera.sample", "1.0.0", [CROW]))), join(included, "vera.sample"));
    const store = storeFor(home, included);
    expect(store.entries().map((entry) => [entry.id, entry.included, entry.enabled])).toEqual([["vera.sample", true, true]]);
    expect(store.themes().map((theme) => theme.name)).toEqual(["Crow Night"]);
    expect(store.remove("vera.sample")).toBe("included");
    expect(existsSync(join(included, "vera.sample"))).toBe(true);
    const clash = staged(store, themeFiles("vera.sample", "9.0.0", [CROW]));
    expect(store.commit(clash)).toEqual({ ok: false, reason: '"vera.sample" is included with Vera and cannot be replaced.' });
    store.discard(clash);
    expect(store.setEnabled("vera.sample", false)).toBe(false);
    expect(existsSync(extensionStatePath(home))).toBe(false);
    expect(store.entries()[0]?.enabled).toBe(true);
    expect(store.themes().map((theme) => theme.name)).toEqual(["Crow Night"]);
});

test("@core a disabled entry for an included extension in the state file is ignored, one for an installed extension is not", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    unpackEntries(packageEntries(tarGzBytes(themeFiles("vera.sample", "1.0.0", [CROW]))), join(included, "vera.sample"));
    const store = storeFor(home, included);
    install(store, "crow.pack", "1.0.0", [{ label: "Crow Day", name: "Crow Day" }]);
    const state = JSON.stringify({ version: 1, disabled: ["vera.sample", "crow.pack"] });
    writeText(extensionStatePath(home), state);
    const again = storeFor(home, included);
    expect(again.entries().map((entry) => [entry.id, entry.enabled])).toEqual([["crow.pack", false], ["vera.sample", true]]);
    expect(again.themes().map((theme) => theme.name)).toEqual(["Crow Night"]);
    expect(again.setEnabled("vera.sample", true)).toBe(false);
    expect(readFileSync(extensionStatePath(home), "utf8")).toBe(state);
});

function taskExtension(directory: string, id: string, worker = true): void {
    const manifest = {
        id,
        version: "1.0.0",
        engine: DESKTOP_ENGINE,
        contributes: {
            tasks: [{ id: "scan", title: "Crow Scan", main: "scan.cjs" }],
            commands: [
                { command: `${id}.scan`, title: "Scan", category: "Crow", task: "scan", file: { label: "Crow files", extensions: ["json"] } },
                { command: `${id}.list`, title: "List", task: "scan" },
            ],
            menus: {
                appearance: [{ command: `${id}.scan`, title: "Scan for crows", description: "Find crows.", button: "Scan" }, { command: `${id}.list` }],
                theme: [{ command: `${id}.scan` }],
                browser: [],
            },
        },
    };
    writeText(join(directory, id, "vera.desktop.json"), JSON.stringify(manifest));
    if (worker) writeText(join(directory, id, "scan.cjs"), "module.exports = {};");
}

test("@core only an included extension hands out the task of its command, and it stays on", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    taskExtension(included, "vera.scan");
    taskExtension(included, "vera.lost", false);
    taskExtension(extensionsDirectory(home), "crow.scan");
    writeText(extensionStatePath(home), JSON.stringify({ version: 1, disabled: ["vera.scan", "crow.scan"] }));
    const store = storeFor(home, included);
    expect(store.commandTarget("vera.scan.scan")).toEqual({
        taskFile: join(included, "vera.scan", "scan.cjs"),
        taskTitle: "Crow Scan",
        file: { label: "Crow files", extensions: ["json"] },
    });
    expect(store.commandTarget("vera.scan.list")).toEqual({ taskFile: join(included, "vera.scan", "scan.cjs"), taskTitle: "Crow Scan" });
    expect(store.commandTarget("vera.scan.other")).toBeUndefined();
    expect(store.commandTarget("vera.lost.scan")).toBeUndefined();
    expect(store.commandTarget("crow.scan.scan")).toBeUndefined();
    expect(store.commandTarget("absent.scan")).toBeUndefined();
    expect(store.entries().find((entry) => entry.id === "vera.scan")).toMatchObject({ hasMain: true, hasCommands: true, included: true, enabled: true });
    expect(store.setEnabled("vera.scan", false)).toBe(false);
    expect(store.commandTarget("vera.scan.scan")?.taskFile).toBe(join(included, "vera.scan", "scan.cjs"));
});

test("@core the entries list the commands and menu entries of an included extension only, titled for the place", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    taskExtension(included, "vera.scan");
    taskExtension(extensionsDirectory(home), "crow.scan");
    const store = storeFor(home, included);
    const entries = store.entries();
    expect(entries.find((entry) => entry.id === "vera.scan")).toMatchObject({
        commands: [{ id: "vera.scan.scan", title: "Scan", category: "Crow" }, { id: "vera.scan.list", title: "List" }],
        menus: {
            appearance: [{ command: "vera.scan.scan", title: "Scan for crows", description: "Find crows.", button: "Scan" }, { command: "vera.scan.list", title: "List" }],
            theme: [{ command: "vera.scan.scan", title: "Scan" }],
            browser: [],
        },
    });
    expect(entries.find((entry) => entry.id === "crow.scan")).toMatchObject({ commands: [], menus: { appearance: [], theme: [], browser: [] } });
    expect(store.menu("theme")).toEqual([{ command: "vera.scan.scan", title: "Scan" }]);
    expect(store.menu("appearance").map((item) => item.command)).toEqual(["vera.scan.scan", "vera.scan.list"]);
});

test("a task worker that is not a regular file inside the extension is refused", () => {
    const included = scratchDirectory();
    taskExtension(included, "vera.scan", false);
    mkdirSync(join(included, "vera.scan", "scan.cjs"));
    expect(storeFor(scratchDirectory(), included).commandTarget("vera.scan.scan")).toBeUndefined();
});

test("@core an included page-only extension surfaces its command and browser menu, while installed code stays hidden", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    const manifest = (id: string) => JSON.stringify({
        id,
        version: "1.0.0",
        engine: DESKTOP_ENGINE,
        contributes: {
            commands: [{ command: `${id}.select`, title: "Select element", page: "pages/select.js" }],
            menus: { browser: [{ command: `${id}.select`, icon: "pointer" }] },
        },
    });
    writeText(join(included, "vera.page", "vera.desktop.json"), manifest("vera.page"));
    writeText(join(included, "vera.page", "pages", "select.js"), "document.body;\n");
    writeText(join(extensionsDirectory(home), "crow.page", "vera.desktop.json"), manifest("crow.page"));
    writeText(join(extensionsDirectory(home), "crow.page", "pages", "select.js"), "document.body;\n");

    const store = storeFor(home, included);
    expect(store.entries()).toMatchObject([
        { id: "crow.page", included: false, commands: [], menus: { browser: [] } },
        { id: "vera.page", included: true, commands: [{ id: "vera.page.select", title: "Select element" }], menus: { browser: [{ command: "vera.page.select", title: "Select element", icon: "pointer", page: true }] } },
    ]);
    expect(store.menu("browser")).toEqual([{ command: "vera.page.select", title: "Select element", icon: "pointer", page: true }]);
    expect(store.pageScript("vera.page.select")).toBe("document.body;\n");
    expect(store.pageScript("crow.page.select")).toBeUndefined();
});

test("page scripts that are missing, linked through a nested directory, or oversized are refused", () => {
    const included = scratchDirectory();
    const writePageExtension = (id: string, page: string): string => {
        const folder = join(included, id);
        writeText(join(folder, "vera.desktop.json"), JSON.stringify({
            id,
            version: "1.0.0",
            engine: DESKTOP_ENGINE,
            contributes: {
                commands: [{ command: `${id}.select`, title: "Select element", page }],
                menus: { browser: [{ command: `${id}.select`, icon: "pointer" }] },
            },
        }));
        return folder;
    };
    writePageExtension("vera.missing", "pages/select.js");
    const linked = writePageExtension("vera.linked", "nested/select.js");
    mkdirSync(join(linked, "nested"));
    const external = writeText(join(scratchDirectory(), "select.js"), "external page script");
    symlinkSync(external, join(linked, "nested", "select.js"));
    const oversized = writePageExtension("vera.large", "select.js");
    writeText(join(oversized, "select.js"), "x".repeat(MAX_PAGE_SCRIPT_BYTES + 1));

    const store = storeFor(scratchDirectory(), included);
    expect(store.pageScript("vera.missing.select")).toBeUndefined();
    expect(store.pageScript("vera.linked.select")).toBeUndefined();
    expect(store.pageScript("vera.large.select")).toBeUndefined();
});

test("@core turning an extension off hides its themes, persists across stores, and removing it resets the switch", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    install(store, "crow.pack", "1.0.0", [CROW]);
    expect(store.setEnabled("crow.pack", false)).toBe(true);
    expect(store.themes()).toEqual([]);
    const again = storeFor(home);
    expect(again.entries()[0]?.enabled).toBe(false);
    expect(again.themes()).toEqual([]);
    expect(JSON.parse(readFileSync(extensionStatePath(home), "utf8"))).toEqual({ version: 1, disabled: ["crow.pack"] });
    expect(again.remove("crow.pack")).toBe("removed");
    install(again, "crow.pack", "1.0.0", [CROW]);
    expect(again.entries()[0]?.enabled).toBe(true);
    expect(again.setEnabled("not.installed", false)).toBe(false);
});

test("@core remove deletes the folder and refuses a name that is not an installed extension", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    install(store, "crow.pack", "1.0.0", [CROW]);
    writeText(join(home, "machine", "desktop", "keep.txt"), "x");
    for (const name of ["../keep.txt", "..", ".", "", "crow.pack/themes", "missing"]) expect(store.remove(name)).toBe("missing");
    expect(existsSync(join(home, "machine", "desktop", "keep.txt"))).toBe(true);
    expect(store.remove("crow.pack")).toBe("removed");
    expect(store.entries()).toEqual([]);
    expect(existsSync(join(extensionsDirectory(home), "crow.pack"))).toBe(false);
});

test("@core clearStaging deletes unfinished folders and leaves one an install is still using", () => {
    const home = scratchDirectory();
    const store = storeFor(home);
    install(store, "crow.pack", "1.0.0", [CROW]);
    const root = extensionsDirectory(home);
    mkdirSync(join(root, ".staging-stale"));
    writeFileSync(join(root, ".staging-stale", "file"), "x");
    mkdirSync(join(root, ".staging-old-crow.pack"));
    const busy = store.newStaging();
    store.clearStaging();
    expect(readdirSync(root).sort()).toEqual(["crow.pack", busy.slice(root.length + 1)].sort());
    store.discard(busy);
    store.clearStaging();
    expect(readdirSync(root)).toEqual(["crow.pack"]);
});

test("@core unavailable task and menu contributions are marked only for installed extensions", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    taskExtension(extensionsDirectory(home), "crow.scan");
    taskExtension(included, "vera.scan");
    const entries = storeFor(home, included).entries();
    expect(entries.find((entry) => entry.id === "crow.scan")?.hasUnavailableContributions).toBe(true);
    expect(entries.find((entry) => entry.id === "vera.scan")?.hasUnavailableContributions).toBe(false);
});

test("@core truncation counts only names left after reaching the extension cap", () => {
    const home = scratchDirectory();
    const root = extensionsDirectory(home);
    for (let index = 0; index < MAX_EXTENSIONS; index += 1) bareExtension(root, `crow-${String(index).padStart(3, "0")}`);
    bareExtension(root, "z-last");
    expect(storeFor(home).listing().truncated).toBe(true);

    const otherHome = scratchDirectory();
    const otherRoot = extensionsDirectory(otherHome);
    bareExtension(otherRoot, "crow-only");
    for (let index = 0; index < MAX_EXTENSIONS; index += 1) mkdirSync(join(otherRoot, `.hidden-${index}`));
    expect(storeFor(otherHome).listing().truncated).toBe(false);
});

test("folders that are not extensions are not listed: wrong folder name, bad manifest, files, dot folders", () => {
    const home = scratchDirectory();
    const root = extensionsDirectory(home);
    writeText(join(root, "has space", "vera.desktop.json"), "{}");
    writeText(join(root, "empty", "placeholder"), "x");
    writeText(join(root, "broken", "vera.desktop.json"), "{");
    writeText(join(root, "crow.pack", "vera.desktop.json"), JSON.stringify({ id: "other.id", version: "1.0.0", engine: DESKTOP_ENGINE }));
    writeText(join(root, "stray.txt"), "x");
    bareExtension(root, ".hidden");
    const listing = storeFor(home).listing();
    expect(listing.entries).toEqual([]);
    expect(listing.diagnostics).toEqual([
        { directory: "broken", problem: "vera.desktop.json is not valid JSON." },
        { directory: "crow.pack", problem: 'The folder name must match the extension id "other.id".' },
        { directory: "empty", problem: "No vera.desktop.json in this folder." },
        { directory: "has space", problem: "The folder name is not a valid extension id." },
    ]);
    expect(listing.diagnostics.some(({ directory }) => directory === "stray.txt" || directory === ".hidden")).toBe(false);
});

test("a missing extensions folder has no listing problem, but a file at its path does", () => {
    const missingHome = scratchDirectory();
    expect(storeFor(missingHome).listing().listingProblem).toBeUndefined();

    const fileHome = scratchDirectory();
    const root = extensionsDirectory(fileHome);
    mkdirSync(join(fileHome, "machine", "desktop"), { recursive: true });
    writeFileSync(root, "not a folder");
    expect(storeFor(fileHome).listing().listingProblem).toBe("The extensions folder could not be read.");
});
