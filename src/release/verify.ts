import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
    packedAnnexRoot,
    RELEASE_ANNEX_NAME,
    RELEASE_BUN_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
    releaseDirectory,
    veraShareRoot,
} from "./layout.ts";
import { readStampedRelease } from "./stamp.ts";

export const ANNEX_ASSET_FILES = [
    "index.html",
    "main.js",
    "styles.css",
    "build-id",
] as const;

const RELEASE_WRAPPERS = [
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_WORKER_NAME,
    RELEASE_ANNEX_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_BUN_NAME,
] as const;

const RUNTIME_ENTRIES = [
    "clients",
    "config",
    "extensions",
    "src",
    "index.ts",
    "package.json",
    "tsconfig.json",
    "bunfig.toml",
    "node_modules",
] as const;

export function digestPackedAnnex(directory: string): string {
    const hash = createHash("sha256");
    for (const name of ANNEX_ASSET_FILES) {
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(join(directory, name)));
        hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
}

function fail(releaseRoot: string, detail: string): never {
    throw new Error(`Release at ${releaseRoot} failed verification: ${detail}`);
}

function requireEntry(releaseRoot: string, relative: string): void {
    const path = join(releaseRoot, relative);
    let stat: ReturnType<typeof lstatSync>;
    try {
        stat = lstatSync(path);
    } catch {
        fail(releaseRoot, `missing ${relative}`);
    }
    if (!stat.isFile() && !stat.isDirectory()) {
        fail(releaseRoot, `${relative} is not a file or directory`);
    }
}

function requireRegularFile(releaseRoot: string, relative: string): void {
    const path = join(releaseRoot, relative);
    let stat: ReturnType<typeof lstatSync>;
    try {
        stat = lstatSync(path);
    } catch {
        fail(releaseRoot, `missing ${relative}`);
    }
    if (!stat.isFile()) {
        fail(releaseRoot, `${relative} is not a file`);
    }
}

function requireExecutable(releaseRoot: string, name: string): void {
    const path = join(releaseRoot, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
        stat = lstatSync(path);
    } catch {
        fail(releaseRoot, `missing executable ${name}`);
    }
    if (!stat.isFile()) {
        fail(releaseRoot, `${name} is not a file`);
    }
    if ((stat.mode & 0o111) === 0) {
        fail(releaseRoot, `${name} is not executable`);
    }
}

/**
 * Confirm a packed release is complete enough to activate. Does not write
 * ~/.vera and does not change `current`.
 */
export function verifyPackedRelease(
    releaseRoot: string,
    prefix?: string,
): void {
    const manifest = readStampedRelease(releaseRoot);
    if (prefix !== undefined) {
        const expected = releaseDirectory(manifest.build_id, prefix);
        if (realpathSync(releaseRoot) !== realpathSync(expected)) {
            fail(
                releaseRoot,
                `must live at ${expected} under ${veraShareRoot(prefix)}`,
            );
        }
    }
    const annexRoot = packedAnnexRoot(releaseRoot);
    for (const name of ANNEX_ASSET_FILES) {
        requireRegularFile(releaseRoot, join("annex", name));
    }
    const stampedId = readFileSync(join(annexRoot, "build-id"), "utf8").trim();
    if (stampedId !== manifest.build_id) {
        fail(
            releaseRoot,
            `annex/build-id is ${stampedId}, manifest is ${manifest.build_id}`,
        );
    }
    const digest = digestPackedAnnex(annexRoot);
    if (digest !== manifest.asset_digest) {
        fail(
            releaseRoot,
            `annex digest is ${digest}, manifest is ${manifest.asset_digest}`,
        );
    }
    for (const name of RELEASE_WRAPPERS) {
        requireExecutable(releaseRoot, name);
    }
    for (const entry of RUNTIME_ENTRIES) {
        requireEntry(releaseRoot, entry);
    }
    requireRegularFile(releaseRoot, join("clients", "cli", "main.ts"));
    requireRegularFile(releaseRoot, join("clients", "host", "main.ts"));
    requireRegularFile(releaseRoot, join("src", "annex", "main.ts"));
}
