import { afterEach, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readManifest } from "../../clients/desktop/src/theme-import/manifest.ts";
import { importThemeFile } from "../../clients/desktop/src/theme-import/import-theme.ts";
import { MAX_FILE_BYTES, zipSource } from "../../clients/desktop/src/theme-import/source.ts";
import { bufferSource, readZipDirectory, readZipEntry } from "../../clients/desktop/src/theme-import/zip.ts";
import { ThemeStore, themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import {
    buildZip,
    manifestText,
    pirateCrowText,
    removeScratchDirectories,
    scratchDirectory,
    writeText,
    type ZipFile,
} from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

function vsix(files: readonly ZipFile[]): { store: ThemeStore; home: string; path: string } {
    const home = scratchDirectory();
    const path = join(scratchDirectory(), "pirate-crow-pack.vsix");
    writeFileSync(path, buildZip(files));
    return { store: new ThemeStore(themesDirectory(home)), home, path };
}

function reason(outcome: ReturnType<typeof importThemeFile>): string {
    if (outcome.ok) throw new Error("Expected a refusal.");
    return outcome.reason;
}

const TWO_THEMES: readonly ZipFile[] = [
    {
        name: "extension/package.json",
        text: manifestText([
            { label: "Pirate Crow Night", uiTheme: "vs-dark", path: "./themes/night.json" },
            { label: "Pirate Crow Day", uiTheme: "vs", path: "./themes/day.json" },
        ]),
    },
    { name: "extension/themes/night.json", text: pirateCrowText({ name: "ignored", type: undefined }) },
    { name: "extension/themes/day.json", text: JSON.stringify({ colors: { "editor.background": "#fbf7ee", foreground: "#2b2b2b" } }), stored: true },
    { name: "extension/readme.md", text: "not json" },
];

test("@core a .vsix with several themes imports each one as its own choice", () => {
    const { store, path } = vsix(TWO_THEMES);
    const outcome = importThemeFile(store, path);
    expect(outcome.ok && outcome.imported.map((theme) => theme.name)).toEqual(["Pirate Crow Night", "Pirate Crow Day"]);
    expect(outcome.ok && outcome.skipped).toEqual([]);
    expect(store.list().map((theme) => [theme.name, theme.type, theme.source])).toEqual([
        ["Pirate Crow Day", "light", "Extension Pirate Crow Pack"],
        ["Pirate Crow Night", "dark", "Extension Pirate Crow Pack"],
    ]);
    expect(store.list().find((theme) => theme.slug === "pirate-crow-day")?.colors.surface).toBe("#fbf7ee");
});

test("@core a theme of the .vsix that fails is skipped with its reason while the others import", () => {
    const { store, path } = vsix([
        {
            name: "extension/package.json",
            text: manifestText([
                { label: "Good Crow", path: "./good.json" },
                { label: "Bare Crow", path: "./bare.json" },
                { label: "Lost Crow", path: "./lost.json" },
            ]),
        },
        { name: "extension/good.json", text: pirateCrowText() },
        { name: "extension/bare.json", text: JSON.stringify({ colors: { "editor.findMatchBackground": "#ff0000" } }) },
    ]);
    const outcome = importThemeFile(store, path);
    expect(outcome.ok && outcome.imported.map((theme) => theme.name)).toEqual(["Good Crow"]);
    expect(outcome.ok && outcome.skipped).toEqual([
        "Bare Crow: \"Bare Crow\" sets none of the colors Vera reads, such as editor.background or sideBar.background, so it is not a VS Code color theme.",
        "Lost Crow: The .vsix has no file \"extension/lost.json\".",
    ]);
});

test("@core a .vsix whose themes all fail is refused with the first reason and saves nothing", () => {
    const { home, store, path } = vsix([
        { name: "extension/package.json", text: manifestText([{ label: "Bare Crow", path: "./bare.json" }]) },
        { name: "extension/bare.json", text: "{ \"colors\": {} }" },
    ]);
    expect(reason(importThemeFile(store, path))).toContain("sets none of the colors Vera reads");
    expect(() => readdirSync(themesDirectory(home))).toThrow();
});

test("a .vsix follows include inside the archive and refuses one that leaves it", () => {
    const { store, path } = vsix([
        {
            name: "extension/package.json",
            text: manifestText([
                { label: "Nested Crow", path: "./themes/nested.json" },
                { label: "Escaping Crow", path: "./themes/escape.json" },
            ]),
        },
        { name: "extension/themes/nested.json", text: JSON.stringify({ include: "./base.json", colors: { foreground: "#eeeeee" } }) },
        { name: "extension/themes/base.json", text: JSON.stringify({ colors: { "editor.background": "#101010" } }) },
        { name: "extension/themes/escape.json", text: JSON.stringify({ include: "../../../outside.json", colors: { foreground: "#eeeeee" } }) },
    ]);
    const outcome = importThemeFile(store, path);
    expect(outcome.ok && outcome.imported.map((theme) => theme.name)).toEqual(["Nested Crow"]);
    expect(outcome.ok && outcome.skipped[0]).toContain("points outside the .vsix");
    expect(store.list()[0]?.colors.surface).toBe("#101010");
});

test("package.nls.json fills a %key% label", () => {
    const { store, path } = vsix([
        { name: "extension/package.json", text: manifestText([{ label: "%theme.night%", path: "./night.json" }], { displayName: "%displayName%" }) },
        { name: "extension/package.nls.json", text: JSON.stringify({ "theme.night": "Crow Night", displayName: { message: "Crow Pack" } }) },
        { name: "extension/night.json", text: pirateCrowText() },
    ]);
    const outcome = importThemeFile(store, path);
    expect(outcome.ok && outcome.imported[0]).toMatchObject({ name: "Crow Night", source: "Extension Crow Pack" });
});

test("@core an archive that is not a .vsix, has no manifest or contributes no themes is refused", () => {
    const home = scratchDirectory();
    const store = new ThemeStore(themesDirectory(home));
    const dir = scratchDirectory();
    expect(reason(importThemeFile(store, writeText(join(dir, "fake.vsix"), "this is not a zip file at all")))).toBe("The file is not a readable .vsix archive.");
    expect(reason(importThemeFile(store, writeText(join(dir, "empty.vsix"), "")))).toBe("The file is not a readable .vsix archive.");
    const noManifest = join(dir, "no-manifest.vsix");
    writeFileSync(noManifest, buildZip([{ name: "other/package.json", text: "{}" }]));
    expect(reason(importThemeFile(store, noManifest))).toContain("has no extension/package.json");
    const noThemes = join(dir, "no-themes.vsix");
    writeFileSync(noThemes, buildZip([{ name: "extension/package.json", text: JSON.stringify({ name: "crow-lang", contributes: { languages: [] } }) }]));
    expect(reason(importThemeFile(store, noThemes))).toBe("The extension does not contribute any color themes.");
});

test("a truncated archive is refused rather than read past its end", () => {
    const store = new ThemeStore(themesDirectory(scratchDirectory()));
    const zip = buildZip(TWO_THEMES);
    const path = join(scratchDirectory(), "cut.vsix");
    writeFileSync(path, zip.subarray(0, zip.length - 40));
    expect(reason(importThemeFile(store, path))).toBe("The file is not a readable .vsix archive.");
});

test("@core the zip reader reads stored and deflated entries by name and offset", () => {
    const zip = buildZip([
        { name: "a.json", text: "{\"a\": 1}", stored: true },
        { name: "dir/b.json", text: JSON.stringify({ crow: "caw ".repeat(500) }) },
        { name: "c.txt", text: "skipped" },
    ]);
    const source = bufferSource(zip);
    const entries = readZipDirectory(source, (name) => name.endsWith(".json"));
    expect([...entries.keys()]).toEqual(["a.json", "dir/b.json"]);
    expect(readZipEntry(source, entries.get("a.json")!, 1024).toString()).toBe("{\"a\": 1}");
    expect(JSON.parse(readZipEntry(source, entries.get("dir/b.json")!, 1_000_000).toString()).crow).toBe("caw ".repeat(500));
});

test("the zip reader stops an entry larger than the cap before it unpacks", () => {
    const zip = buildZip([{ name: "big.json", text: JSON.stringify({ filler: "y".repeat(5000) }) }]);
    const source = bufferSource(zip);
    const entry = readZipDirectory(source, () => true).get("big.json")!;
    expect(() => readZipEntry(source, entry, 1000)).toThrow(/larger than/);
    const lying = { ...entry, size: 10 };
    expect(() => readZipEntry(source, lying, 1000)).toThrow();
});

test("a theme inside an archive past the file cap is refused", () => {
    const zip = buildZip([{ name: "extension/big.json", text: `{ "pad": "${"z".repeat(MAX_FILE_BYTES)}" }` }]);
    expect(() => zipSource(bufferSource(zip)).read("extension/big.json")).toThrow(/larger than 2 MiB/);
});

test("zip paths resolve inside the archive and refuse one that climbs out of it", () => {
    const source = zipSource(bufferSource(buildZip([{ name: "extension/package.json", text: "{}" }])));
    expect(source.resolve("extension/package.json", "./themes/a.json")).toBe("extension/themes/a.json");
    expect(source.resolve("extension/themes/a.json", "../b.json")).toBe("extension/b.json");
    expect(() => source.resolve("extension/package.json", "../../x.json")).toThrow(/outside the .vsix/);
    expect(source.resolve("extension/package.json", "/etc/x.json")).toBe("extension/etc/x.json");
});

test("the manifest reader drops contributions without a label or a path and caps the count", () => {
    const manifest = readManifest(JSON.stringify({
        name: "crow-themes",
        contributes: { themes: [{ label: "A", path: "./a.json" }, { path: "./b.json" }, { label: "C" }, "junk", ...Array.from({ length: 300 }, (_, index) => ({ label: `T${index}`, path: `./t${index}.json` }))] },
    }));
    expect(manifest.extension).toBe("crow-themes");
    expect(manifest.themes).toHaveLength(200);
    expect(manifest.themes[0]).toEqual({ label: "A", uiTheme: undefined, path: "./a.json" });
});
