import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import { COLOR_TOKENS } from "../../clients/ui/src/theme/tokens.ts";
import { parseCatalog } from "../../clients/desktop/src/extension-catalog/parse-catalog.ts";
import { runInstallTask } from "../../clients/desktop/src/extension-install/run-task.ts";
import { packageEntries } from "../../clients/desktop/src/extension-install/unpack.ts";
import { packArchive } from "../../catalog/archive.ts";
import {
    buildCatalog,
    CATALOG_BASE_URL,
    CATALOG_FILE,
    OUTPUT_DIR,
    PACKAGE_SUFFIX,
    SOURCE_DIR,
} from "../../catalog/build-catalog.ts";
import { CatalogBuildError } from "../../catalog/build-error.ts";
import { removeScratchDirectories, scratchDirectory } from "./theme-fixtures.ts";

afterEach(removeScratchDirectories);

const REBUILD = "Run `bun run catalog:build` and commit catalog/published.";

function names(folder: string): string[] {
    return readdirSync(folder).sort();
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

test("@core the committed catalog is what the build script writes from the sources", () => {
    const rebuilt = join(scratchDirectory(), "published");
    buildCatalog({ sourceDir: SOURCE_DIR, outDir: rebuilt, baseUrl: CATALOG_BASE_URL });
    const committed = existsSync(OUTPUT_DIR) ? names(OUTPUT_DIR) : [];
    const problems: string[] = [];
    for (const name of new Set([...committed, ...names(rebuilt)])) {
        if (!committed.includes(name)) problems.push(`${name} is built but not committed`);
        else if (!existsSync(join(rebuilt, name))) problems.push(`${name} is committed but no longer built`);
        else if (!readFileSync(join(rebuilt, name)).equals(readFileSync(join(OUTPUT_DIR, name)))) problems.push(`${name} differs from a rebuild`);
    }
    if (problems.length > 0) throw new Error(`catalog/published is out of date with catalog/extensions:\n${problems.join("\n")}\n${REBUILD}`);
});

test("@core the committed catalog is listed by the desktop's parser and every package installs", () => {
    const bytes = readFileSync(join(OUTPUT_DIR, CATALOG_FILE));
    const listed = parseCatalog(bytes, DESKTOP_ENGINE);
    const raw = JSON.parse(bytes.toString("utf8")) as { extensions: unknown[] };
    const sources = readdirSync(SOURCE_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(listed.length).toBe(raw.extensions.length);
    expect(listed.map((entry) => entry.id).sort()).toEqual(sources.sort());
    for (const entry of listed) {
        expect(entry.url).toBe(`${CATALOG_BASE_URL}/${entry.id}-${entry.version}${PACKAGE_SUFFIX}`);
        const packagePath = join(OUTPUT_DIR, basename(entry.url));
        const packageBytes = readFileSync(packagePath);
        expect(packageBytes.length).toBe(entry.size);
        expect(sha256(packageBytes)).toBe(entry.sha256);
        const staging = join(scratchDirectory(), ".staging-install");
        mkdirSync(staging);
        const reply = runInstallTask({ kind: "install", packagePath, sha256: entry.sha256, staging });
        expect(reply).toMatchObject({ ok: true, preview: { id: entry.id, version: entry.version } });
    }
});

test("the same files always pack to the same bytes, and the desktop reads them back", () => {
    const files = new Map([
        ["vera.desktop.json", Buffer.from("{}\n")],
        ["themes/crow.json", Buffer.from("night")],
    ]);
    const packed = packArchive(files);
    expect(packArchive(new Map([...files].reverse()))).toEqual(packed);
    expect([...packed.subarray(0, 10)]).toEqual([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]);
    expect(packageEntries(packed).map((entry) => [entry.path, entry.kind, entry.data.toString()])).toEqual([
        ["themes", "directory", ""],
        ["themes/crow.json", "file", "night"],
        ["vera.desktop.json", "file", "{}\n"],
    ]);
});

test("a file larger than one stored block survives the gzip round trip", () => {
    const data = Buffer.alloc(200_000);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 31) % 251;
    const [entry] = packageEntries(packArchive(new Map([["big.bin", data]])));
    expect(entry?.data.equals(data)).toBe(true);
    expect(gunzipSync(packArchive(new Map([["big.bin", data]]))).length).toBe(512 + 200_192 + 1024);
});

const FOLDER = "vera.onyx";
const THEME = join(FOLDER, "themes", "onyx.json");
const MANIFEST = join(FOLDER, "vera.desktop.json");

function editJson(root: string, path: string, edit: (value: Record<string, any>) => void): void {
    const file = join(root, path);
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    edit(value);
    writeFileSync(file, JSON.stringify(value, null, 4));
}

const REFUSED: readonly [string, (root: string) => void, string][] = [
    ["a missing color", (root) => editJson(root, THEME, (theme) => delete theme.colors.accent), "colors.accent must be #rrggbb"],
    ["an uppercase color", (root) => editJson(root, THEME, (theme) => (theme.colors.text = "#DEDDD7")), "colors.text must be #rrggbb"],
    ["an unknown color token", (root) => editJson(root, THEME, (theme) => (theme.colors.glow = "#ffffff")), '"colors" is missing, malformed'],
    ["an unknown theme key", (root) => editJson(root, THEME, (theme) => (theme.extra = 1)), '"extra" is missing, malformed'],
    ["a missing source", (root) => editJson(root, THEME, (theme) => delete theme.source), '"source" is missing, malformed'],
    ["an unknown value", (root) => editJson(root, THEME, (theme) => (theme.values.font = "serif")), '"values" is missing, malformed'],
    ["a palette color with an alpha part", (root) => editJson(root, THEME, (theme) => (theme.colors.surface = "#07080aff")), "would not list this entry"],
    ["a file the manifest does not list", (root) => writeFileSync(join(root, FOLDER, "notes.txt"), "x"), "notes.txt is not listed in the manifest"],
    ["a manifest id that is not the folder name", (root) => editJson(root, MANIFEST, (manifest) => (manifest.id = "vera.other")), "does not match the folder name"],
    ["a version that is not x.y.z", (root) => editJson(root, MANIFEST, (manifest) => (manifest.version = "1.0")), "must be x.y.z"],
    [
        "a command",
        (root) => editJson(root, MANIFEST, (manifest) => (manifest.contributes.commands = [{ command: "vera.onyx.go", title: "Go", task: "go" }])),
        "Command",
    ],
    ["another engine", (root) => editJson(root, MANIFEST, (manifest) => (manifest.engine = "vera-gui@^2")), "not supported"],
    ["a theme path that is not normalized", (root) => editJson(root, MANIFEST, (manifest) => (manifest.contributes.themes[0].path = "./themes/onyx.json")), "must be written as themes/<file>.json"],
];

function copiedSources(): { sources: string; out: string } {
    const root = scratchDirectory();
    const sources = join(root, "extensions");
    cpSync(SOURCE_DIR, sources, { recursive: true });
    return { sources, out: join(root, "published") };
}

function failureOf(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        if (error instanceof CatalogBuildError) return error.message;
        throw error;
    }
    throw new Error("The build did not fail.");
}

for (const [label, edit, message] of REFUSED) {
    test(`a source with ${label} is refused with its reason and nothing is written`, () => {
        const { sources, out } = copiedSources();
        edit(sources);
        mkdirSync(out);
        writeFileSync(join(out, CATALOG_FILE), "kept");
        expect(failureOf(() => buildCatalog({ sourceDir: sources, outDir: out, baseUrl: CATALOG_BASE_URL }))).toContain(message);
        expect(names(out)).toEqual([CATALOG_FILE]);
        expect(readFileSync(join(out, CATALOG_FILE), "utf8")).toBe("kept");
    });
}

test("a base URL that is not http or https is refused", () => {
    const { sources, out } = copiedSources();
    expect(failureOf(() => buildCatalog({ sourceDir: sources, outDir: out, baseUrl: "ftp://example.invalid/catalog" }))).toContain("would not list this entry");
    expect(existsSync(out)).toBe(false);
});

test("a rebuild removes packages the sources no longer produce and leaves other files", () => {
    const { sources, out } = copiedSources();
    mkdirSync(out);
    writeFileSync(join(out, `vera.old-0.1.0${PACKAGE_SUFFIX}`), "old");
    writeFileSync(join(out, "notes.txt"), "kept");
    const written = buildCatalog({ sourceDir: sources, outDir: out, baseUrl: `${CATALOG_BASE_URL}/` });
    expect(names(out)).toEqual(["catalog.json", "notes.txt", `vera.onyx-1.0.0${PACKAGE_SUFFIX}`, `vera.purple-1.0.0${PACKAGE_SUFFIX}`]);
    expect(written.sort()).toEqual(["catalog.json", `vera.onyx-1.0.0${PACKAGE_SUFFIX}`, `vera.purple-1.0.0${PACKAGE_SUFFIX}`]);
    expect(readFileSync(join(out, CATALOG_FILE)).equals(readFileSync(join(OUTPUT_DIR, CATALOG_FILE)))).toBe(true);
});

test("every desktop color token is required in a catalog theme", () => {
    for (const token of COLOR_TOKENS) {
        const { sources, out } = copiedSources();
        editJson(sources, THEME, (theme) => delete theme.colors[token]);
        expect(failureOf(() => buildCatalog({ sourceDir: sources, outDir: out, baseUrl: CATALOG_BASE_URL }))).toContain(`colors.${token} must be`);
    }
});
