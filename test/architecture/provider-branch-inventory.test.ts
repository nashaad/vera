import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "../..");
const PROVIDER_IDS = [
    "cerebras",
    "deepseek",
    "openai-codex",
    "openrouter",
    "ollama",
    "omlx",
] as const;

/**
 * The direct provider-name branches that remain before the resolver slices.
 * Keep this list intentionally explicit: each later migration should remove
 * an entry, rather than quietly adding another vendor condition to generic
 * code. Provider-specific implementation modules and resource tables are
 * listed separately because their existence is not itself a branch.
 */
const PROVIDER_NAME_BRANCH_FILES = new Set([
    "src/annex/usage-report.ts",
    "src/engine/model-settings.ts",
    "src/host/runtime.ts",
    "src/model/reasoning-effort.ts",
    "src/model/settings-overlay.ts",
    "src/providers/openrouter.ts",
]);

const PROVIDER_NAME_BRANCH = new RegExp(
    String.raw`\b(?:provider|config\.provider|model\.provider|this\.profile\.provider)\s*(?:===|!==)\s*["'](?:${PROVIDER_IDS.join("|")})["']`,
);

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    });
}

test("provider-name branches are confined to the current migration inventory", () => {
    const matches = sourceFiles(join(ROOT, "src"))
        .concat(sourceFiles(join(ROOT, "clients")))
        .flatMap((path) => {
            const lines = readFileSync(path, "utf8").split("\n");
            return lines.some((line) => PROVIDER_NAME_BRANCH.test(line))
                ? [relative(ROOT, path)]
                : [];
        })
        .sort();

    expect(matches).toEqual([...PROVIDER_NAME_BRANCH_FILES].sort());
});

test("the migration inventory names every provider-specific source table", () => {
    const expectedSources = [
        "src/config.ts",
        "src/providers/registry.ts",
        "src/providers/executable-contributions.ts",
        "clients/provider-doctor.ts",
        "src/model/refreshable-providers.ts",
        "src/host/runtime.ts",
    ];

    for (const path of expectedSources) {
        expect(existsSync(join(ROOT, path))).toBe(true);
    }
    expect(readFileSync(join(ROOT, "src/providers/configured.ts"), "utf8"))
        .not.toContain("ADAPTERS");
    expect(readFileSync(join(ROOT, "clients/provider-doctor.ts"), "utf8"))
        .not.toContain("BUILT_IN_ENDPOINTS");
    expect(readFileSync(join(ROOT, "src/model/refreshable-providers.ts"), "utf8"))
        .not.toContain("REFRESHABLE_PROVIDERS");
});
