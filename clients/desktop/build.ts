import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { extensionFramePage } from "./extension-frame-page.ts";
import { EXTENSION_FRAME_FILE } from "./src/extension-frame-file.ts";
import { ASSIGNMENT_TASK_FILE } from "./src/model-assignments/task-protocol.ts";
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
const TASKS = [
    { entry: join(root, "src", "theme-import", "worker.ts"), file: THEME_TASK_FILE },
    { entry: join(root, "src", "model-assignments", "worker.ts"), file: ASSIGNMENT_TASK_FILE },
];
for (const task of TASKS) {
    const bundle = await Bun.build({
        entrypoints: [task.entry],
        outdir: out,
        target: "node",
        format: "cjs",
        external: ["electron"],
        naming: task.file,
    });
    if (!bundle.success) fail(bundle.logs);
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
    naming: "[name].[ext]",
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

// The frame page carries the worker bootstrap as text, so extensions start with no file read in the frame.
const sandbox = join(root, "..", "ui", "src", "extensions", "sandbox");
const workerBoot = await Bun.build({
    entrypoints: [join(sandbox, "worker-main.ts")],
    target: "browser",
    format: "iife",
});
if (!workerBoot.success) fail(workerBoot.logs);
const frameBoot = await Bun.build({
    entrypoints: [join(sandbox, "frame-main.ts")],
    target: "browser",
    format: "iife",
    define: { __WORKER_SOURCE__: JSON.stringify(await workerBoot.outputs[0]!.text()) },
});
if (!frameBoot.success) fail(frameBoot.logs);
await Bun.write(join(rendererOut, EXTENSION_FRAME_FILE), extensionFramePage(await frameBoot.outputs[0]!.text()));

const index = join(root, "index.html");
if (!existsSync(index)) throw new Error(`Missing ${index}`);
cpSync(index, join(rendererOut, "index.html"));

// Bundled config code reads provider definitions from this folder.
cpSync(join(root, "..", "..", "src", "providers", "definitions"), join(out, "definitions"), { recursive: true });

function fail(logs: readonly unknown[]): never {
    for (const log of logs) console.error(log);
    process.exit(1);
}
