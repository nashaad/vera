#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_NAME = "@nashaad/vera";
const REGISTRY = "https://registry.npmjs.org";
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function fail(message: string): never {
    console.error(`vera npm release: ${message}`);
    process.exit(1);
}

interface ViewResult {
    readonly found: boolean;
    readonly value?: unknown;
}

function view(spec: string, field: string): ViewResult {
    const result = Bun.spawnSync(
        ["npm", "view", spec, field, "--json", `--registry=${REGISTRY}`],
        { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode === 0) {
        const text = result.stdout?.toString().trim() ?? "";
        return { found: true, value: text === "" ? undefined : JSON.parse(text) };
    }
    const error = result.stderr?.toString() ?? "";
    if (error.includes("E404") || error.includes("404 Not Found")) return { found: false };
    process.stderr.write(error);
    fail(`registry query failed for ${spec}`);
}

function compareVersions(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
        const difference = a[index]! - b[index]!;
        if (difference !== 0) return difference;
    }
    return 0;
}

function localIntegrity(archive: string): string {
    return `sha512-${createHash("sha512")
        .update(readFileSync(archive))
        .digest("base64")}`;
}

function publishedIntegrity(version: string): ViewResult {
    return view(`${PACKAGE_NAME}@${version}`, "dist.integrity");
}

function assertPublished(
    version: string,
    integrity: string,
    requireProvenance: boolean,
    allowPendingMetadata = false,
): boolean {
    const published = publishedIntegrity(version);
    if (!published.found) return false;
    if (published.value !== integrity) {
        fail(`registry integrity differs for ${PACKAGE_NAME}@${version}`);
    }
    const latest = view(PACKAGE_NAME, "dist-tags.latest");
    if (!latest.found || latest.value !== version) {
        if (allowPendingMetadata) return false;
        fail(`npm latest does not point at ${version}: ${String(latest.value)}`);
    }
    if (requireProvenance) {
        const attestations = view(`${PACKAGE_NAME}@${version}`, "dist.attestations");
        if (!attestations.found || attestations.value === undefined) {
            if (allowPendingMetadata) return false;
            fail(`provenance is missing for ${PACKAGE_NAME}@${version}`);
        }
    }
    return true;
}

const [mode, archiveArgument, version, provenanceFlag] = Bun.argv.slice(2);
if (mode !== "prepare" && mode !== "verify") {
    fail("usage: scripts/check-npm-release.ts <prepare|verify> <package.tgz> <version> [--require-provenance]");
}
if (archiveArgument === undefined || version === undefined || !STABLE_VERSION.test(version)) {
    fail("a package archive and stable version are required");
}
const requireProvenance = provenanceFlag === "--require-provenance";
const integrity = localIntegrity(resolve(archiveArgument));

if (mode === "verify") {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        if (assertPublished(version, integrity, requireProvenance, true)) {
            console.log(JSON.stringify({ published: true, version, integrity }));
            process.exit(0);
        }
        await Bun.sleep(5_000);
    }
    fail(`${PACKAGE_NAME}@${version} did not appear in the registry`);
}

if (assertPublished(version, integrity, requireProvenance)) {
    console.log("publish=false");
    console.log(`integrity=${integrity}`);
    process.exit(0);
}

const latest = view(PACKAGE_NAME, "dist-tags.latest");
if (latest.found && latest.value !== undefined) {
    if (typeof latest.value !== "string" || !STABLE_VERSION.test(latest.value)) {
        fail(`npm latest is not stable semver: ${String(latest.value)}`);
    }
    if (compareVersions(version, latest.value) <= 0) {
        fail(`refusing to move npm latest backward from ${latest.value} to ${version}`);
    }
}
console.log("publish=true");
console.log(`integrity=${integrity}`);
