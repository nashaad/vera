import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { packageEntries, unpackEntries } from "../../clients/desktop/src/extension-install/unpack.ts";
import { MAX_EXTENSIONS } from "../../clients/desktop/src/extensions/limits.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore, themeKey } from "../../clients/desktop/src/extensions/store.ts";
import { tarGzBytes, themeFiles, type FixtureTheme, type TarItem } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory, writeText } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function storeFor(home: string, included?: string): ExtensionStore {
    return new ExtensionStore(extensionsDirectory(home), new ExtensionStateStore(extensionStatePath(home)), included);
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
        { id: "crow.pack", version: "1.2.0", themes: ["Crow Night", "Crow Day"], hasMain: false, hasCommands: false, included: false, enabled: true },
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
    expect(result).toEqual({ ok: true, id: "crow.pack", replaced: "1.0.0" });
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

test("@core included extensions are listed, can be turned off, and cannot be removed or replaced", () => {
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
    expect(store.setEnabled("vera.sample", false)).toBe(true);
    expect(store.themes()).toEqual([]);
    expect(storeFor(home, included).entries()[0]?.enabled).toBe(false);
});

function taskExtension(directory: string, id: string, worker = true): void {
    const manifest = { id, version: "1.0.0", engine: DESKTOP_ENGINE, contributes: { tasks: [{ id: "scan", title: "Crow Scan", main: "scan.cjs" }] } };
    writeText(join(directory, id, "vera.desktop.json"), JSON.stringify(manifest));
    if (worker) writeText(join(directory, id, "scan.cjs"), "module.exports = {};");
}

test("@core only an included extension that is turned on hands out the worker file of its task", () => {
    const home = scratchDirectory();
    const included = scratchDirectory();
    taskExtension(included, "vera.scan");
    taskExtension(included, "vera.lost", false);
    taskExtension(extensionsDirectory(home), "crow.scan");
    const store = storeFor(home, included);
    expect(store.taskFile("vera.scan", "scan")).toBe(join(included, "vera.scan", "scan.cjs"));
    expect(store.taskFile("vera.scan", "other")).toBeUndefined();
    expect(store.taskFile("vera.lost", "scan")).toBeUndefined();
    expect(store.taskFile("crow.scan", "scan")).toBeUndefined();
    expect(store.taskFile("absent", "scan")).toBeUndefined();
    expect(store.entries().find((entry) => entry.id === "vera.scan")).toMatchObject({ hasMain: true, hasCommands: false, included: true });
    expect(store.setEnabled("vera.scan", false)).toBe(true);
    expect(store.taskFile("vera.scan", "scan")).toBeUndefined();
    expect(store.setEnabled("vera.scan", true)).toBe(true);
    expect(store.taskFile("vera.scan", "scan")).toBe(join(included, "vera.scan", "scan.cjs"));
});

test("a task worker that is not a regular file inside the extension is refused", () => {
    const included = scratchDirectory();
    taskExtension(included, "vera.scan", false);
    mkdirSync(join(included, "vera.scan", "scan.cjs"));
    expect(storeFor(scratchDirectory(), included).taskFile("vera.scan", "scan")).toBeUndefined();
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

test("folders that are not extensions are not listed: wrong folder name, bad manifest, files, dot folders", () => {
    const home = scratchDirectory();
    const root = extensionsDirectory(home);
    writeText(join(root, "crow.pack", "vera.desktop.json"), JSON.stringify({ id: "other.id", version: "1.0.0", engine: DESKTOP_ENGINE }));
    writeText(join(root, "broken", "vera.desktop.json"), "{");
    writeText(join(root, "stray.txt"), "x");
    bareExtension(root, ".hidden");
    expect(storeFor(home).entries()).toEqual([]);
});
