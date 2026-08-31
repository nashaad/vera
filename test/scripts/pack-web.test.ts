import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { packedBuildId } from "../../src/release/build-id.ts";
import { packedReleaseRoot, packedWebRoot } from "../../src/release/layout.ts";
import { packWebAssets } from "../../scripts/pack-web.ts";

const packer = resolve(import.meta.dir, "..", "..", "scripts", "pack-web.ts");
const repoRoot = resolve(import.meta.dir, "..", "..");

test("packed web root is the release web directory", () => {
    expect(packedWebRoot()).toBe(join(packedReleaseRoot(), "web"));
    expect(packedWebRoot().split(sep)).not.toContain("clients");
});

test("packed build id is vera-shortsha with dirty when the tree is dirty", () => {
    const id = packedBuildId(repoRoot);
    expect(id).toMatch(/^vera-[0-9a-f]+(\+dirty)?$/);
});

test("pack-web writes index.html, main.js, and styles.css", async () => {
    const output = mkdtempSync(join(tmpdir(), "vera-release-test-"));
    const result = await packWebAssets(output, { force: true });
    expect(result.packed).toBe(true);
    expect(result.buildId).toMatch(/^vera-[0-9a-f]+(\+dirty)?$/);
    expect(readFileSync(join(output, "index.html"), "utf8")).toContain("Vera · Usage");
    expect(readFileSync(join(output, "styles.css"), "utf8").length).toBeGreaterThan(0);
    const javascript = readFileSync(join(output, "main.js"), "utf8");
    expect(javascript).toContain("at current OpenRouter rates");
    expect(javascript).toContain("/api/usage");
    expect(readFileSync(join(output, "build-id"), "utf8").trim()).toBe(result.buildId);
});

test("pack-web CLI writes into a throwaway directory", () => {
    const output = mkdtempSync(join(tmpdir(), "vera-release-test-"));
    const ran = Bun.spawnSync(["bun", packer, output, "--force"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString().trim()).toBe(output);
    expect(statSync(join(output, "index.html")).isFile()).toBe(true);
    expect(statSync(join(output, "main.js")).isFile()).toBe(true);
    expect(statSync(join(output, "styles.css")).isFile()).toBe(true);
});

test("pack-web skips when the output is newer than its inputs", async () => {
    const output = mkdtempSync(join(tmpdir(), "vera-release-test-"));
    const first = await packWebAssets(output, { force: true });
    expect(first.packed).toBe(true);
    const second = await packWebAssets(output);
    expect(second.packed).toBe(false);
    expect(second.buildId).toBe(first.buildId);

    const html = join(output, "index.html");
    const past = new Date(Date.now() - 60_000);
    utimesSync(html, past, past);
    writeFileSync(join(output, "build-id"), "vera-stale\n");
    const third = await packWebAssets(output);
    expect(third.packed).toBe(true);
});
