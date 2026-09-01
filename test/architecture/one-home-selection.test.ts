import { expect, test } from "bun:test";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Public daily-user selection that the one-home reset deleted. A private
 * home for tests or `dev:tui` is `VERA_HOME`, not a second island.
 */
const FORBIDDEN =
    /\bVERA_PROFILE\b|\bVERA_RUNTIME_DIR\b|(?:^|[\s`"'=])--profile(?:\s|=|$|["'`])/;

const PRODUCT_GLOBS = [
    "src/**/*.{ts,md}",
    "clients/**/*.ts",
    "scripts/**/*.{ts,sh}",
    "python/vera/**/*.py",
];

const ALLOWED = new Set([
    "scripts/dev-tui.ts",
    "scripts/one-home-container-uat.sh",
]);

async function productHits(): Promise<string[]> {
    const hits: string[] = [];
    for (const pattern of PRODUCT_GLOBS) {
        for await (const path of new Bun.Glob(pattern).scan({
            cwd: REPO_ROOT,
            absolute: true,
        })) {
            const key = relative(REPO_ROOT, path).replaceAll("\\", "/");
            if (ALLOWED.has(key)) continue;
            const source = await Bun.file(path).text();
            if (FORBIDDEN.test(source)) hits.push(key);
        }
    }
    return hits.sort();
}

test("the detector matches a profile or runtime-island read", () => {
    expect(FORBIDDEN.test('process.env["VERA_PROFILE"]')).toBe(true);
    expect(FORBIDDEN.test("env.VERA_RUNTIME_DIR")).toBe(true);
    expect(FORBIDDEN.test("vera --profile dogfood")).toBe(true);
    expect(FORBIDDEN.test("DEFAULT_PROFILE_NAME")).toBe(false);
    expect(FORBIDDEN.test("StartupProfile")).toBe(false);
    expect(FORBIDDEN.test("VERA_HOME")).toBe(false);
});

test("product code does not select a profile or runtime island", async () => {
    expect(await productHits()).toEqual([]);
});
