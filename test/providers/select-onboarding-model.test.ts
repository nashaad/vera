import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOptionalVeraConfig } from "../../src/config.ts";
import { readUserPoolFile } from "../../src/model/pool-file-store.ts";
import { selectOnboardingModel } from "../../src/providers/select-onboarding-model.ts";

test("a verified model becomes the kept default in real stores", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-model-default-"));
    const configPath = join(root, "config.json");
    const poolPath = join(root, "pool.json");
    try {
        await selectOnboardingModel({ provider: "openrouter", model: "crow-0", configPath, poolPath,
            verify: async () => ({ provider: "openrouter", model: "crow-0", status: "passed" }) });
        expect(loadOptionalVeraConfig({ path: configPath })).toMatchObject({ provider: "openrouter", model: "crow-0" });
        expect(readUserPoolFile({ path: poolPath }).models["openrouter/crow-0"]?.added).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a refused model leaves the default and membership alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-model-refusal-"));
    const configPath = join(root, "config.json");
    const poolPath = join(root, "pool.json");
    try {
        await expect(selectOnboardingModel({ provider: "openrouter", model: "crow-0", configPath, poolPath,
            verify: async () => ({ provider: "openrouter", model: "crow-0", status: "failed", reason: "refused" }) })).rejects.toThrow("refused");
        expect(loadOptionalVeraConfig({ path: configPath })).toBeUndefined();
        expect(readUserPoolFile({ path: poolPath }).models).toEqual({});
    } finally { rmSync(root, { recursive: true, force: true }); }
});
