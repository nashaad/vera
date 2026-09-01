import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { releaseBuildId } from "../../src/release/build-id.ts";
import { packedReleaseRoot, packedAnnexRoot } from "../../src/release/layout.ts";
import { packWebAssets } from "../../scripts/pack-web.ts";

const packer = resolve(import.meta.dir, "..", "..", "scripts", "pack-web.ts");
const repoRoot = resolve(import.meta.dir, "..", "..");

test("packed annex root is the release annex directory", () => {
    expect(packedAnnexRoot()).toBe(join(packedReleaseRoot(), "annex"));
    expect(packedAnnexRoot().split(sep)).not.toContain("clients");
});

test("packed build id is vera-shortsha plus a digest when the tree is dirty", () => {
    const id = releaseBuildId(repoRoot);
    expect(id).toMatch(/^vera-[0-9a-f]+(\+[0-9a-f]{12})?$/);
});

test("pack-web writes index.html, main.js, and styles.css", async () => {
    const output = mkdtempSync(join(tmpdir(), "vera-release-test-"));
    const result = await packWebAssets(output, { force: true });
    expect(result.packed).toBe(true);
    expect(result.buildId).toMatch(/^vera-[0-9a-f]+(\+[0-9a-f]{12})?$/);
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

test("dev scripts pack web assets first", () => {
    const pkg = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["pack:web"]).toBe(
        "bun run scripts/pack-web.ts dist/release/annex",
    );
    expect(pkg.scripts["pack:release"]).toBe(
        "bun run scripts/pack-release.ts dist/release",
    );
    expect(pkg.scripts.host?.startsWith("bun run pack:release &&")).toBe(true);
    expect(pkg.scripts.tui?.startsWith("bun run pack:release &&")).toBe(true);
    expect(pkg.scripts["tui:worktree"]?.startsWith("bun run pack:release &&"))
        .toBe(true);
    expect(pkg.scripts["dev:tui"]?.startsWith("bun run pack:release &&"))
        .toBe(true);
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
