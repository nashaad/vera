#!/usr/bin/env bun

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packedBuildId } from "../src/release/build-id.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SOURCE_DIR = join(REPO_ROOT, "clients", "web");
const SOURCE_FILES = [
    "index.html",
    "main.tsx",
    "App.tsx",
    "sessions-table.ts",
    "styles.css",
] as const;
const OUTPUT_FILES = ["index.html", "main.js", "styles.css"] as const;
const BUILD_ID_FILE = "build-id";

export interface PackWebResult {
    readonly outputDirectory: string;
    readonly buildId: string;
    readonly packed: boolean;
}

export interface PackWebOptions {
    readonly sourceRoot?: string;
    readonly cwd?: string;
    readonly force?: boolean;
}

function fail(message: string): never {
    console.error(`vera pack-web: ${message}`);
    process.exit(1);
}

function fileMtime(path: string): number | undefined {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return undefined;
    }
}

function outputIsFresh(
    outputDirectory: string,
    inputPaths: readonly string[],
    buildId: string,
): boolean {
    const outputs = OUTPUT_FILES.map((name) => join(outputDirectory, name));
    const buildIdPath = join(outputDirectory, BUILD_ID_FILE);
    let recordedId: string;
    try {
        recordedId = readFileSync(buildIdPath, "utf8").trim();
    } catch {
        return false;
    }
    if (recordedId !== buildId) return false;
    const outputTimes = [...outputs, buildIdPath].map(fileMtime);
    if (outputTimes.some((mtime) => mtime === undefined)) return false;
    const oldestOutput = Math.min(...outputTimes as number[]);
    const inputTimes = inputPaths.map(fileMtime);
    if (inputTimes.some((mtime) => mtime === undefined)) return false;
    return Math.max(...inputTimes as number[]) <= oldestOutput;
}

export async function packWebAssets(
    outputDirectory: string,
    options: PackWebOptions = {},
): Promise<PackWebResult> {
    const sourceRoot = options.sourceRoot ?? WEB_SOURCE_DIR;
    const cwd = options.cwd ?? REPO_ROOT;
    const target = resolve(outputDirectory);
    const buildId = packedBuildId(cwd);
    const inputPaths = [
        ...SOURCE_FILES.map((name) => join(sourceRoot, name)),
        fileURLToPath(import.meta.url),
    ];
    if (options.force !== true && outputIsFresh(target, inputPaths, buildId)) {
        return { outputDirectory: target, buildId, packed: false };
    }

    mkdirSync(target, { recursive: true });
    const html = await Bun.file(join(sourceRoot, "index.html")).text();
    const css = await Bun.file(join(sourceRoot, "styles.css")).text();
    const built = await Bun.build({
        entrypoints: [join(sourceRoot, "main.tsx")],
        target: "browser",
        format: "esm",
        minify: false,
    });
    if (!built.success) {
        const detail = built.logs.map((log) => String(log)).join("\n");
        throw new Error(`pack-web failed to bundle:\n${detail}`);
    }
    const script = built.outputs.find((output) =>
        output.path.endsWith(".js") || output.type === "entry-point"
    );
    if (script === undefined) {
        throw new Error("pack-web produced no JavaScript");
    }
    await Bun.write(join(target, "index.html"), html);
    await Bun.write(join(target, "styles.css"), css);
    await Bun.write(join(target, "main.js"), await script.text());
    await Bun.write(join(target, BUILD_ID_FILE), `${buildId}\n`);
    return { outputDirectory: target, buildId, packed: true };
}

function parseArgs(argv: readonly string[]): {
    readonly outputDirectory: string;
    readonly force: boolean;
} {
    let force = false;
    const positional: string[] = [];
    for (const arg of argv) {
        if (arg === "--force") {
            force = true;
            continue;
        }
        if (arg.startsWith("-")) {
            fail(`unknown flag: ${arg}`);
        }
        positional.push(arg);
    }
    const outputDirectory = positional[0];
    if (outputDirectory === undefined || positional.length !== 1) {
        fail("usage: scripts/pack-web.ts <output-directory> [--force]");
    }
    return { outputDirectory, force };
}

if (import.meta.main) {
    try {
        const { outputDirectory, force } = parseArgs(Bun.argv.slice(2));
        const result = await packWebAssets(outputDirectory, { force });
        process.stdout.write(`${result.outputDirectory}\n`);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}
