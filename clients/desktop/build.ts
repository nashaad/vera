import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CATALOG_TASK_FILE } from "./src/extension-catalog/task-protocol.ts";
import { DESKTOP_MANIFEST_FILENAME, parseDesktopManifest } from "../ui/src/extensions/manifest.ts";
import { EXTENSION_TASK_FILE } from "./src/extension-install/task-protocol.ts";
import { releaseBuildId } from "../../src/release/build-id.ts";
import { DESKTOP_BUILD_ID_SYMBOL } from "./src/client-build.ts";
import { ASSIGNMENT_TASK_FILE } from "./src/model-assignments/task-protocol.ts";
import { UPDATE_TASK_FILE } from "./src/update/task-protocol.ts";

const root = import.meta.dir;

function argument(name: string): string | undefined {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
}

// `--out <folder>` builds an app folder of its own; `--catalog-url <url>` fixes the extension catalog this build reads;
// `--build-id <id>` stamps the build the desktop compares with the installed release (default: this checkout's build id).
const appFolder = argument("--out") ?? root;
const catalogUrl = argument("--catalog-url");
const buildId = argument("--build-id") ?? sourceBuildId();
const out = join(appFolder, "dist");
if (appFolder !== root) {
    mkdirSync(appFolder, { recursive: true });
    writeFileSync(join(appFolder, "package.json"), JSON.stringify({ name: "vera-desktop-build", version: "0.0.0", type: "module", main: "dist/main.js" }));
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const define: Record<string, string> = {};
if (catalogUrl !== undefined) define.__VERA_CATALOG_URL__ = JSON.stringify(catalogUrl);
if (buildId !== undefined) define[DESKTOP_BUILD_ID_SYMBOL] = JSON.stringify(buildId);
const main = await Bun.build({
    entrypoints: [join(root, "src", "main.ts")],
    outdir: out,
    target: "node",
    format: "esm",
    external: ["electron"],
    naming: "[name].[ext]",
    define,
});
if (!main.success) fail(main.logs);

const preload = await Bun.build({
    entrypoints: [join(root, "src", "preload.ts")],
    outdir: out,
    target: "node",
    format: "cjs",
    external: ["electron"],
    naming: "[name].cjs",
});
if (!preload.success) fail(preload.logs);

// Each task runs in a process of its own, from a bundle that main.js never loads.
const TASKS = [
    { entry: join(root, "src", "model-assignments", "worker.ts"), file: ASSIGNMENT_TASK_FILE },
    { entry: join(root, "src", "extension-install", "worker.ts"), file: EXTENSION_TASK_FILE },
    { entry: join(root, "src", "extension-catalog", "worker.ts"), file: CATALOG_TASK_FILE },
    { entry: join(root, "src", "update", "worker.ts"), file: UPDATE_TASK_FILE },
];
async function bundleTask(entry: string, outdir: string, file: string): Promise<void> {
    const bundle = await Bun.build({ entrypoints: [entry], outdir, target: "node", format: "cjs", external: ["electron"], naming: file });
    if (!bundle.success) fail(bundle.logs);
}
for (const task of TASKS) await bundleTask(task.entry, out, task.file);

// Desktop extensions that ship with the app, each a folder of the repository holding a vera.desktop.json. The
// manifest is copied to dist/extensions/<id>/, and each task's `main` (`<name>.cjs`) is bundled from `<name>.ts`
// in the same folder.
const INCLUDED_EXTENSIONS = ["vscode-theme-import", "browser-annotate", "local-html-preview"].map((name) => join(root, "..", "..", "extensions", name));
const TASK_MAIN = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.cjs$/;
for (const folder of INCLUDED_EXTENSIONS) {
    const manifestFile = join(folder, DESKTOP_MANIFEST_FILENAME);
    const parsed = parseDesktopManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
    if (!parsed.ok) fail([`${manifestFile}: ${parsed.reason}`]);
    const outdir = join(out, "extensions", parsed.manifest.id);
    mkdirSync(outdir, { recursive: true });
    copyFileSync(manifestFile, join(outdir, DESKTOP_MANIFEST_FILENAME));
    for (const task of parsed.manifest.tasks) {
        const name = TASK_MAIN.exec(task.main)?.[1];
        if (name === undefined) fail([`${manifestFile}: task "${task.id}" main "${task.main}" must be a <name>.cjs file in the extension folder.`]);
        await bundleTask(join(folder, `${name}.ts`), outdir, task.main);
    }
    for (const command of parsed.manifest.commands) {
        if (command.page === undefined) continue;
        const name = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.js$/.exec(command.page)?.[1];
        if (name === undefined) fail([`${manifestFile}: page must be a <name>.js file in the extension folder.`]);
        const bundle = await Bun.build({ entrypoints: [join(folder, `${name}.ts`)], outdir, target: "browser", format: "iife", naming: command.page });
        if (!bundle.success) fail(bundle.logs);
    }
}

const rendererOut = join(out, "renderer");
const renderer = await Bun.build({
    entrypoints: [join(root, "..", "ui", "src", "main.tsx")],
    outdir: rendererOut,
    target: "browser",
    format: "esm",
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
    },
    // Code grammars load on demand, each from its own chunk next to main.js.
    splitting: true,
    naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "[name].[ext]" },
});
if (!renderer.success) fail(renderer.logs);

const themeBoot = await Bun.build({
    entrypoints: [join(root, "..", "ui", "src", "theme", "boot.ts")],
    outdir: rendererOut,
    target: "browser",
    format: "iife",
    naming: "theme-boot.js",
});
if (!themeBoot.success) fail(themeBoot.logs);

const index = join(root, "index.html");
if (!existsSync(index)) throw new Error(`Missing ${index}`);
cpSync(index, join(rendererOut, "index.html"));

// Bundled config code reads provider definitions from this folder.
cpSync(join(root, "..", "..", "src", "providers", "definitions"), join(out, "definitions"), { recursive: true });

// Desktop extensions that ship with the app: one folder each, with its vera.desktop.json at the root.
const included = join(root, "extensions");
if (existsSync(included)) cpSync(included, join(out, "extensions"), { recursive: true });

// The id a release packed from this checkout carries, so the installed-build check compares like with like.
function sourceBuildId(): string | undefined {
    try {
        return releaseBuildId(join(root, "..", ".."));
    } catch (error) {
        console.warn(`No desktop build id: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

function fail(logs: readonly unknown[]): never {
    for (const log of logs) console.error(log);
    process.exit(1);
}
