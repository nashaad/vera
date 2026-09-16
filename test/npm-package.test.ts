import { expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const builder = resolve(import.meta.dir, "..", "scripts", "build-npm-package.ts");
const validator = resolve(import.meta.dir, "..", "scripts", "validate-npm-package.ts");

function run(
    command: string[],
    options: Parameters<typeof Bun.spawnSync>[1] = {},
): ReturnType<typeof Bun.spawnSync> {
    return Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", ...options });
}

test("npm package contains only the curated runtime and release metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-package-test-"));
    try {
        const sourcePackage = JSON.parse(
            readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8"),
        ) as { dependencies: Record<string, string> };
        const bunLock = readFileSync(resolve(import.meta.dir, "..", "bun.lock"), "utf8");
        const packages: Record<string, Record<string, string>> = {};
        for (const name of Object.keys(sourcePackage.dependencies)) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const version = bunLock.match(
                new RegExp(`^\\s*"${escaped}": \\["${escaped}@([^"\\s]+)"`, "m"),
            )?.[1];
            expect(version).toBeDefined();
            packages[`node_modules/${name}`] = {
                version: version!,
                resolved: `https://registry.npmjs.org/${name}/-/${version}.tgz`,
                integrity: "sha512-ZmFrZQ==",
            };
        }
        const shrinkwrap = join(root, "npm-shrinkwrap.json");
        writeFileSync(shrinkwrap, JSON.stringify({
            name: "fixture",
            version: "0.0.0",
            lockfileVersion: 3,
            requires: true,
            packages,
        }));
        const built = run(["bun", builder, "1.2.3", root], {
            env: {
                ...process.env,
                VERA_NPM_SOURCE_ROOT: resolve(import.meta.dir, ".."),
                VERA_NPM_SHRINKWRAP_SOURCE: shrinkwrap,
            },
        });
        expect(built.exitCode).toBe(0);
        const archive = built.stdout?.toString().trim() ?? "";
        expect(archive).toEndWith("nashaad-vera-1.2.3.tgz");

        const listing = run(["tar", "-tzf", archive]);
        expect(listing.exitCode).toBe(0);
        const entries = (listing.stdout?.toString() ?? "").split("\n").filter(Boolean);
        expect(entries).toContain("package/bin/vera");
        expect(entries).toContain("package/clients/cli/main.ts");
        expect(entries).toContain("package/extensions/mcp/extension.ts");
        expect(entries).toContain("package/extensions/web-search/extension.ts");
        expect(entries).toContain("package/extensions/web-search/search.ts");
        expect(entries).toContain("package/extensions/web-search/vera.extension.json");
        expect(entries).toContain("package/config/tui-themes.json");
        expect(entries).toContain("package/npm-shrinkwrap.json");
        expect(entries.some((entry) => entry.startsWith("package/test/"))).toBe(false);
        expect(entries.some((entry) => entry.startsWith("package/scripts/"))).toBe(false);
        expect(entries).not.toContain("package/README.md");
        expect(entries).not.toContain("package/bun.lock");

        const extracted = run(["tar", "-xzf", archive, "-C", root]);
        expect(extracted.exitCode).toBe(0);
        const packageRoot = join(root, "package");
        const metadata = JSON.parse(
            readFileSync(join(packageRoot, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(metadata.name).toBe("@nashaad/vera");
        expect(metadata.version).toBe("1.2.3");
        expect(metadata.private).toBeUndefined();
        expect(metadata.bin).toEqual({ vera: "./bin/vera" });
        expect(metadata.engines).toEqual({ bun: ">=1.3.6" });
        expect(metadata.repository).toEqual({
            type: "git",
            url: "git+https://github.com/nashaad/vera.git",
        });
        expect((metadata.dependencies as Record<string, string>)["@opentui/core"])
            .toMatch(/^\d+\.\d+\.\d+$/);
        expect((metadata.dependencies as Record<string, string>).sharp).toBe("0.35.3");
        expect(readFileSync(join(packageRoot, "VERSION"), "utf8")).toBe("1.2.3\n");
        expect(statSync(join(packageRoot, "bin", "vera")).mode & 0o111).not.toBe(0);

        const validated = run(["bun", validator, archive, "1.2.3"]);
        expect(validated.exitCode).toBe(0);
        expect(JSON.parse(validated.stdout?.toString() ?? "{}").name)
            .toBe("@nashaad/vera");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("npm package builder rejects non-stable versions", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-version-test-"));
    try {
        const result = run(["bun", builder, "1.2.3-rc.1", root], {
            env: { ...process.env, VERA_NPM_SOURCE_ROOT: resolve(import.meta.dir, "..") },
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr?.toString() ?? "").toContain("invalid stable version");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
