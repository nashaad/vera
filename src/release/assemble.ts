import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { bundleRelease } from "./bundle.ts";
import { packedAnnexRoot } from "./layout.ts";
import { writeSelfContainedWrappers } from "./wrappers.ts";

// Desktop and the shared UI install their own dependencies and stay out of the
// release until a released client uses them.
const EXCLUDED_CLIENT_DIRECTORIES = new Set(["desktop", "ui"]);

const RUNTIME_ENTRIES = [
    "clients",
    "config",
    "docs",
    "extensions",
    "src",
    "index.ts",
    "package.json",
    "tsconfig.json",
    "bunfig.toml",
] as const;

export async function assembleRunnableRelease(
    releaseRoot: string,
    sourceRoot: string,
): Promise<void> {
    if (!existsSync(packedAnnexRoot(releaseRoot))) {
        throw new Error(
            `Packed annex assets missing at ${packedAnnexRoot(releaseRoot)}`,
        );
    }
    for (const entry of RUNTIME_ENTRIES) {
        const from = join(sourceRoot, entry);
        if (!existsSync(from)) {
            throw new Error(`Release source is missing ${entry} at ${from}`);
        }
        if (entry === "clients") copyClients(from, join(releaseRoot, entry));
        else copyInto(from, join(releaseRoot, entry));
    }
    // docs/site is the website build project, not reading material.
    rmSync(join(releaseRoot, "docs", "site"), { recursive: true, force: true });
    const modules = join(sourceRoot, "node_modules");
    if (!existsSync(modules)) {
        throw new Error(
            `Release source has no node_modules at ${modules}. Run bun install.`,
        );
    }
    copyInto(modules, join(releaseRoot, "node_modules"));
    const parserWorker = join(releaseRoot, "node_modules", "@opentui", "core", "parser.worker.js");
    const parserSource = readFileSync(parserWorker, "utf8");
    if (!parserSource.includes('"web-tree-sitter"') || !parserSource.includes('"web-tree-sitter/tree-sitter.wasm"')) {
        throw new Error(`Unexpected OpenTUI parser worker at ${parserWorker}`);
    }
    writeFileSync(parserWorker, parserSource
        .replaceAll('"web-tree-sitter"', '"../../web-tree-sitter/tree-sitter.js"')
        .replaceAll('"web-tree-sitter/tree-sitter.wasm"', '"../../web-tree-sitter/tree-sitter.wasm"'));
    const sdkPackage = join(releaseRoot, "node_modules", "vera");
    mkdirSync(sdkPackage, { recursive: true });
    writeFileSync(join(sdkPackage, "package.json"), JSON.stringify({ name: "vera", type: "module", main: "index.ts" }));
    writeFileSync(join(sdkPackage, "index.ts"), 'export * from "../../index.ts";\n');
    symlinkSync("../../src/sdk", join(sdkPackage, "sdk"));
    await bundleRelease(releaseRoot, sourceRoot);
    writeSelfContainedWrappers(releaseRoot);
}

function copyClients(from: string, to: string): void {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
        if (EXCLUDED_CLIENT_DIRECTORIES.has(name)) continue;
        copyInto(join(from, name), join(to, name));
    }
}

function copyInto(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    if (process.platform === "darwin") {
        const cloned = Bun.spawnSync(["cp", "-Rc", from, to], {
            stdout: "pipe",
            stderr: "pipe",
        });
        if (cloned.exitCode === 0) return;
    }
    const copied = Bun.spawnSync(["cp", "-a", from, to], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (copied.exitCode === 0) return;
    cpSync(from, to, { recursive: true });
}
