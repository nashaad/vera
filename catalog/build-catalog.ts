import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DESKTOP_ENGINE } from "../clients/ui/src/extensions/manifest.ts";
import { CatalogRefusal } from "../clients/desktop/src/extension-catalog/refusal.ts";
import { parseCatalog } from "../clients/desktop/src/extension-catalog/parse-catalog.ts";
import { parseCatalogEntry } from "../clients/desktop/src/extension-catalog/task-protocol.ts";
import { ExtensionRefusal } from "../clients/desktop/src/extension-install/refusal.ts";
import { packageEntries } from "../clients/desktop/src/extension-install/unpack.ts";
import { packArchive } from "./archive.ts";
import { CatalogBuildError, fail } from "./build-error.ts";
import { readExtensionSource, type ExtensionSource } from "./extension-source.ts";

export const SOURCE_DIR = join(import.meta.dir, "extensions");
export const OUTPUT_DIR = join(import.meta.dir, "published");
// Where a release build of the desktop app reads the catalog: the output folder as served from the main branch.
export const CATALOG_BASE_URL = "https://raw.githubusercontent.com/nashaad/vera/main/catalog/published";
export const CATALOG_FILE = "catalog.json";
// Not .tgz, which the repository ignores.
export const PACKAGE_SUFFIX = ".tar.gz";

export interface BuildOptions {
    readonly sourceDir: string;
    readonly outDir: string;
    readonly baseUrl: string;
}

interface BuiltPackage {
    readonly file: string;
    readonly bytes: Buffer;
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function extensionIds(sourceDir: string): string[] {
    const ids = readdirSync(sourceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    if (ids.length === 0) fail(`no extensions found in ${sourceDir}`);
    return ids;
}

function sourcesOf(sourceDir: string): ExtensionSource[] {
    const sources: ExtensionSource[] = [];
    const problems: string[] = [];
    for (const id of extensionIds(sourceDir)) {
        try {
            sources.push(readExtensionSource(join(sourceDir, id), id));
        } catch (error) {
            if (!(error instanceof CatalogBuildError)) throw error;
            problems.push(`${id}: ${error.message}`);
        }
    }
    if (problems.length > 0) fail(problems.join("\n"));
    return sources;
}

// The catalog file as the desktop must read it: every entry listed, with the fields the sources gave.
function requireListed(catalog: Buffer, entries: readonly Record<string, unknown>[]): void {
    let listed;
    try {
        listed = parseCatalog(catalog, DESKTOP_ENGINE);
    } catch (error) {
        if (error instanceof CatalogRefusal) fail(`the desktop refuses the catalog: ${error.message}`);
        throw error;
    }
    if (!isDeepStrictEqual(listed, entries.map(parseCatalogEntry))) fail("the desktop's catalog parser does not list every entry as built");
}

// Builds every extension under `sourceDir` into packages and a catalog in `outDir`, and returns the names written.
// Nothing is written unless every extension validates and the desktop's own readers accept the result.
export function buildCatalog(options: BuildOptions): string[] {
    const base = options.baseUrl.replace(/\/+$/, "");
    const packages: BuiltPackage[] = [];
    const entries: Record<string, unknown>[] = [];
    for (const source of sourcesOf(options.sourceDir)) {
        const bytes = packArchive(source.files);
        try {
            packageEntries(bytes);
        } catch (error) {
            if (error instanceof ExtensionRefusal) fail(`${source.id}: the desktop refuses the package: ${error.message}`);
            throw error;
        }
        const file = `${source.id}-${source.version}${PACKAGE_SUFFIX}`;
        const entry = {
            id: source.id,
            name: source.name,
            version: source.version,
            kind: "theme",
            engine: DESKTOP_ENGINE,
            url: `${base}/${file}`,
            sha256: sha256(bytes),
            size: bytes.length,
            palette: source.palette,
            withdrawn: false,
        };
        if (parseCatalogEntry(entry) === undefined) {
            fail(`${source.id}: the desktop would not list this entry; its name must have no control characters, the first theme's surface, text, accent, success and danger colors must be #rrggbb, and the base URL must be http or https`);
        }
        packages.push({ file, bytes });
        entries.push(entry);
    }
    const catalog = Buffer.from(`${JSON.stringify({ format: 1, extensions: entries }, null, 4)}\n`);
    requireListed(catalog, entries);

    mkdirSync(options.outDir, { recursive: true });
    for (const name of readdirSync(options.outDir)) {
        if (name === CATALOG_FILE || name.endsWith(PACKAGE_SUFFIX)) rmSync(join(options.outDir, name));
    }
    for (const { file, bytes } of packages) writeFileSync(join(options.outDir, file), bytes);
    writeFileSync(join(options.outDir, CATALOG_FILE), catalog);
    return [...packages.map(({ file }) => file), CATALOG_FILE];
}
