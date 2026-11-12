import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

test("@core the renderer bundles for the browser without Bun-only imports", async () => {
    const out = await mkdtemp(join(tmpdir(), "vera-renderer-build-"));
    try {
        const result = await Bun.build({
            entrypoints: [join(root, "clients", "ui", "src", "main.tsx")],
            outdir: out,
            target: "browser",
            format: "esm",
            define: {
                "process.env.NODE_ENV": JSON.stringify("production"),
            },
        });
        expect(result.success).toBe(true);
        for (const output of result.outputs) {
            if (!output.path.endsWith(".js")) continue;
            const text = await output.text();
            expect(text).not.toContain("Bun.");
            expect(text).not.toContain("bun:");
            expect(text).not.toMatch(/["']node:/);
            expect(text).not.toMatch(/["']electron["']/);
        }
    } finally {
        await rm(out, { recursive: true, force: true });
    }
});

test("@core the page applies the stored theme from a blocking script before the stylesheet", async () => {
    const html = await Bun.file(join(root, "clients", "desktop", "index.html")).text();
    const script = html.indexOf("<script src=\"./theme-boot.js\"></script>");
    const sheet = html.indexOf("<link rel=\"stylesheet\"");
    expect(script).toBeGreaterThan(-1);
    expect(sheet).toBeGreaterThan(script);
    expect(html).not.toContain("'unsafe-inline'");
    const out = await mkdtemp(join(tmpdir(), "vera-theme-boot-"));
    try {
        const result = await Bun.build({
            entrypoints: [join(root, "clients", "ui", "src", "theme", "boot.ts")],
            outdir: out,
            target: "browser",
            format: "iife",
            naming: "theme-boot.js",
        });
        expect(result.success).toBe(true);
        const text = await Bun.file(join(out, "theme-boot.js")).text();
        expect(text).not.toMatch(/^\s*(?:import|export)\s/m);
        expect(text).toContain("data-theme");
    } finally {
        await rm(out, { recursive: true, force: true });
    }
});
