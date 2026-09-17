#!/usr/bin/env bun

import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_ROOT = join(REPO_ROOT, "python", "vera");
const OUTPUT_DIRECTORY = join(PACKAGE_ROOT, "_bun");

// The bundle sits as deep as a src/<area>/<module>.ts source did, so the
// repo-root-relative reads below land inside _bun instead of escaping it.
const BUNDLE_DIRECTORY = join(OUTPUT_DIRECTORY, "src", "child");

// Read through import.meta.dir, which is the bundle's own directory once the
// sources are rolled into one file.
const BESIDE_BUNDLE = [
    { from: join(REPO_ROOT, "src", "providers", "definitions"), to: "definitions" },
    { from: join(REPO_ROOT, "src", "skills", "bundled"), to: "bundled" },
] as const;

// Read through ../.. from a module under src/.
const BESIDE_OUTPUT = [
    { from: join(REPO_ROOT, "config"), to: "config" },
] as const;

// The bash parser loads these next to the module that asked for them.
const WASM = [
    "web-tree-sitter/tree-sitter.wasm",
    "tree-sitter-bash/tree-sitter-bash.wasm",
] as const;

export async function buildPythonChild(): Promise<string> {
    await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
    await mkdir(BUNDLE_DIRECTORY, { recursive: true });
    const built = await Bun.build({
        entrypoints: [join(PACKAGE_ROOT, "_child.ts")],
        target: "bun",
        outdir: BUNDLE_DIRECTORY,
        naming: "child.js",
    });
    if (!built.success) {
        const reasons = built.logs.map((log) => String(log)).join("\n");
        throw new Error(`cannot bundle the Python child:\n${reasons}`);
    }
    for (const directory of BESIDE_BUNDLE) {
        await cp(directory.from, join(BUNDLE_DIRECTORY, directory.to), { recursive: true });
    }
    for (const directory of BESIDE_OUTPUT) {
        await cp(directory.from, join(OUTPUT_DIRECTORY, directory.to), { recursive: true });
    }
    for (const specifier of WASM) {
        const source = fileURLToPath(import.meta.resolve(specifier));
        await cp(source, join(BUNDLE_DIRECTORY, basename(source)));
    }
    return join(BUNDLE_DIRECTORY, "child.js");
}

if (import.meta.main) {
    const path = await buildPythonChild();
    console.log(path);
}
