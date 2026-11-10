import { copyFileSync } from "node:fs";
import { join } from "node:path";

const ENTRIES = [
    "clients/cli/main.ts",
    "clients/host/main.ts",
    "clients/host/session-worker.ts",
    "clients/tui/flight-watchdog.ts",
    "src/annex/main.ts",
    "src/host/session-import-child.ts",
    "src/host/worker/adapter.ts",
    "src/host/worker/entry.ts",
    "src/host/worker-supervisor.ts",
] as const;

export async function bundleRelease(releaseRoot: string, sourceRoot: string): Promise<void> {
    const result = await Bun.build({
        entrypoints: ENTRIES.map((entry) => join(sourceRoot, entry)),
        root: sourceRoot,
        outdir: join(releaseRoot, "bundle"),
        target: "bun",
        splitting: true,
        minify: { identifiers: true, syntax: false, whitespace: false },
        sourcemap: "external",
        external: ["@opentui/core", "sharp", "trash", "unpdf"],
    });
    if (!result.success) {
        throw new Error(`Release bundle failed: ${result.logs.map(String).join("; ")}`);
    }
    copyFileSync(
        join(sourceRoot, "node_modules", "web-tree-sitter", "tree-sitter.wasm"),
        join(releaseRoot, "bundle", "tree-sitter.wasm"),
    );
}
