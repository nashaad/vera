import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_MANIFEST_FILENAME } from "../ui/src/extensions/manifest.ts";
import { THEME_IMPORTER_ID } from "../ui/src/extensions/theme-importer.ts";
import { EXTENSION_TASK_FILE } from "./src/extension-install/task-protocol.ts";
import { ASSIGNMENT_TASK_FILE } from "./src/model-assignments/task-protocol.ts";
import { THEME_IMPORTER_MANIFEST } from "./src/theme-import/extension-manifest.ts";
import { THEME_TASK_FILE } from "./src/theme-import/task-protocol.ts";

const root = import.meta.dir;
const out = join(root, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const main = await Bun.build({
    entrypoints: [join(root, "src", "main.ts")],
    outdir: out,
    target: "node",
    format: "esm",
    external: ["electron"],
    naming: "[name].[ext]",
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
// The theme importer is an included extension, so its worker and manifest sit in its own folder.
const TASKS = [
    { entry: join(root, "src", "model-assignments", "worker.ts"), file: ASSIGNMENT_TASK_FILE },
    { entry: join(root, "src", "extension-install", "worker.ts"), file: EXTENSION_TASK_FILE },
    { entry: join(root, "src", "theme-import", "worker.ts"), file: THEME_TASK_FILE, outdir: join(out, "extensions", THEME_IMPORTER_ID) },
];
for (const task of TASKS) {
    const bundle = await Bun.build({
        entrypoints: [task.entry],
        outdir: task.outdir ?? out,
        target: "node",
        format: "cjs",
        external: ["electron"],
        naming: task.file,
    });
    if (!bundle.success) fail(bundle.logs);
}
writeFileSync(join(out, "extensions", THEME_IMPORTER_ID, DESKTOP_MANIFEST_FILENAME), `${JSON.stringify(THEME_IMPORTER_MANIFEST, null, 4)}\n`);

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

function fail(logs: readonly unknown[]): never {
    for (const log of logs) console.error(log);
    process.exit(1);
}
