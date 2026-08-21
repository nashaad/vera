#!/usr/bin/env bun

import {
    lstatSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const PACKAGE_NAME = "@nashaad/vera";
const REPOSITORY_URL = "git+https://github.com/nashaad/vera.git";
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const ALLOWED_ROOTS = new Set([
    "VERSION",
    "bin",
    "bunfig.toml",
    "clients",
    "config",
    "extensions",
    "index.ts",
    "npm-shrinkwrap.json",
    "package.json",
    "src",
    "tsconfig.json",
]);

function fail(message: string): never {
    console.error(`vera npm package validation: ${message}`);
    process.exit(1);
}

function run(command: string[]): string {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
        if (result.stderr !== undefined) process.stderr.write(result.stderr);
        fail(`command failed: ${command.join(" ")}`);
    }
    return result.stdout?.toString() ?? "";
}

function rejectSymlinks(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`package contains a symlink: ${path}`);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) rejectSymlinks(join(path, entry));
}

const [archiveArgument, expectedVersion] = Bun.argv.slice(2);
if (archiveArgument === undefined || expectedVersion === undefined) {
    fail("usage: scripts/validate-npm-package.ts <package.tgz> <version>");
}
if (!STABLE_VERSION.test(expectedVersion)) fail(`invalid stable version: ${expectedVersion}`);
const archive = resolve(archiveArgument);

const entries = run(["tar", "-tzf", archive]).split("\n").filter(Boolean);
if (entries.length === 0) fail("package archive is empty");
for (const entry of entries) {
    if (!entry.startsWith("package/")) fail(`entry is outside package/: ${entry}`);
    const relative = entry.slice("package/".length);
    if (relative === "") continue;
    const root = relative.split("/", 1)[0]!;
    if (!ALLOWED_ROOTS.has(root)) fail(`unexpected package root: ${root}`);
    if (relative.split("/").includes("..")) fail(`unsafe package path: ${entry}`);
}

const detailLines = run(["tar", "-tvzf", archive]).split("\n").filter(Boolean);
for (const detail of detailLines) {
    if (detail.startsWith("d") || detail.startsWith("-")) continue;
    fail("package archive contains a link or unsupported entry type");
}

const temporary = mkdtempSync(join(tmpdir(), "vera-npm-validate-"));
try {
    run(["tar", "-xzf", archive, "-C", temporary]);
    const root = join(temporary, "package");
    rejectSymlinks(root);

    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
        bin?: Record<string, string>;
        repository?: { type?: string; url?: string };
        dependencies?: Record<string, string>;
        engines?: Record<string, string>;
        os?: string[];
        cpu?: string[];
        private?: boolean;
    };
    if (metadata.name !== PACKAGE_NAME) fail(`wrong package name: ${metadata.name}`);
    if (metadata.version !== expectedVersion) fail(`wrong package version: ${metadata.version}`);
    if (metadata.private !== undefined) fail("published package must not have private metadata");
    if (metadata.bin?.vera !== "./bin/vera") fail("wrong Vera bin target");
    if (metadata.repository?.type !== "git" || metadata.repository.url !== REPOSITORY_URL) {
        fail("repository metadata does not match the release repository");
    }
    if (metadata.engines?.bun !== ">=1.3.6") fail("wrong Bun engine boundary");
    if (JSON.stringify(metadata.os) !== JSON.stringify(["darwin", "linux"])) {
        fail("wrong OS boundary");
    }
    if (JSON.stringify(metadata.cpu) !== JSON.stringify(["arm64", "x64"])) {
        fail("wrong CPU boundary");
    }
    if (metadata.dependencies === undefined || Object.keys(metadata.dependencies).length === 0) {
        fail("runtime dependencies are missing");
    }
    for (const [name, version] of Object.entries(metadata.dependencies)) {
        if (!STABLE_VERSION.test(version)) fail(`dependency is not exact registry semver: ${name}@${version}`);
    }

    const shrinkwrap = JSON.parse(
        readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"),
    ) as {
        name?: string;
        version?: string;
        lockfileVersion?: number;
        packages?: Record<string, {
            name?: string;
            version?: string;
            resolved?: string;
            integrity?: string;
            dependencies?: Record<string, string>;
        }>;
    };
    if (shrinkwrap.name !== PACKAGE_NAME || shrinkwrap.version !== expectedVersion) {
        fail("shrinkwrap identity does not match the package");
    }
    if (shrinkwrap.lockfileVersion !== 3 || shrinkwrap.packages === undefined) {
        fail("npm shrinkwrap must use lockfile version 3");
    }
    const shrinkwrapRoot = shrinkwrap.packages[""];
    if (shrinkwrapRoot?.name !== PACKAGE_NAME || shrinkwrapRoot.version !== expectedVersion) {
        fail("shrinkwrap root does not match the package");
    }
    if (JSON.stringify(shrinkwrapRoot.dependencies) !== JSON.stringify(metadata.dependencies)) {
        fail("shrinkwrap root dependencies do not match package.json");
    }
    for (const name of Object.keys(metadata.dependencies)) {
        if (shrinkwrap.packages[`node_modules/${name}`] === undefined) {
            fail(`shrinkwrap is missing direct dependency: ${name}`);
        }
    }
    for (const [path, locked] of Object.entries(shrinkwrap.packages)) {
        if (path === "") continue;
        if (!path.startsWith("node_modules/")) fail(`unexpected shrinkwrap package path: ${path}`);
        if (locked.version !== undefined && !STABLE_VERSION.test(locked.version)) {
            fail(`non-registry shrinkwrap version at ${path}: ${locked.version}`);
        }
        if (locked.resolved === undefined || !locked.resolved.startsWith("https://registry.npmjs.org/")) {
            fail(`non-npm shrinkwrap source at ${path}: ${locked.resolved}`);
        }
        if (locked.integrity === undefined || !locked.integrity.startsWith("sha512-")) {
            fail(`missing shrinkwrap integrity at ${path}`);
        }
    }

    if (readFileSync(join(root, "VERSION"), "utf8") !== `${expectedVersion}\n`) {
        fail("VERSION does not match package.json");
    }
    if ((statSync(join(root, "bin", "vera")).mode & 0o111) === 0) {
        fail("Vera launcher is not executable");
    }

    const integrity = `sha512-${createHash("sha512")
        .update(readFileSync(archive))
        .digest("base64")}`;
    console.log(JSON.stringify({
        name: PACKAGE_NAME,
        version: expectedVersion,
        integrity,
        files: entries.length,
        dependencies: Object.keys(metadata.dependencies).length,
        lockedPackages: Object.keys(shrinkwrap.packages).length - 1,
    }));
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
