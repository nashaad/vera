import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig, updateVeraConfigDefaults } from "../../src/config.ts";

function withConfigFile(run: (path: string) => void): void {
    const directory = mkdtempSync(join(tmpdir(), "vera-assignment-write-"));
    try {
        const path = join(directory, "config.json");
        writeFileSync(
            path,
            JSON.stringify({ schema_version: 1, model: "seed" }),
        );
        writeFileSync(join(directory, "pool.json"), JSON.stringify({ models: { "openrouter/big-1": { added: true, learned: { probe: { ok: true, seen: "2026-09-06" } } } } }));
        run(path);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("binding a assignment writes it and reads back", () => {
    withConfigFile((path) => {
        updateVeraConfigDefaults({
            model_assignment: {
                assignment: "extra",
                binding: {
                    models: [
                        { name: "big", provider: "openrouter", model: "big-1" },
                    ],
                },
            },
        }, { path });
        const config = loadVeraConfig({ path });
        expect(config.model_assignments?.extra?.models?.[0]?.model).toBe("big-1");
    });
});

test("binding one assignment leaves the others alone", () => {
    withConfigFile((path) => {
        const model = { name: "big", provider: "openrouter" as const, model: "big-1" };
        updateVeraConfigDefaults(
            { model_assignment: { assignment: "extra", binding: { models: [model] } } },
            { path },
        );
        updateVeraConfigDefaults(
            { model_assignment: { assignment: "eco", binding: { models: [model] } } },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(config.model_assignments?.extra).toBeDefined();
        expect(config.model_assignments?.eco).toBeDefined();
    });
});

test("null unbinds only the named assignment", () => {
    withConfigFile((path) => {
        const model = { name: "big", provider: "openrouter" as const, model: "big-1" };
        updateVeraConfigDefaults(
            { model_assignment: { assignment: "extra", binding: { models: [model] } } },
            { path },
        );
        updateVeraConfigDefaults(
            { model_assignment: { assignment: "eco", binding: { models: [model] } } },
            { path },
        );
        updateVeraConfigDefaults(
            { model_assignment: { assignment: "extra", binding: null } },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(config.model_assignments?.extra).toBeUndefined();
        expect(config.model_assignments?.eco).toBeDefined();
    });
});

test("new assignments require independent membership and successful verification", () => {
    withConfigFile((path) => {
        for (const model of ["not-kept", "not-verified"]) {
            expect(() => updateVeraConfigDefaults({ model_assignment: { assignment: "eco", binding: {
                models: [{ name: model, provider: "openrouter", model }],
            } } }, { path })).toThrow("shortlisted and verified");
        }
        expect(loadVeraConfig({ path }).model_assignments?.eco).toBeUndefined();
    });
});
