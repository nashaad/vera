import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { VeraConfig } from "../../src/config.ts";
import { availableModelsWithLevels } from "../../src/model/catalog-view.ts";
import type { AuthStorage } from "../../src/providers/auth-storage.ts";
import {
    discoveredCodexModels,
    ollamaContextWindow,
} from "../../src/host/runtime.ts";

test("Ollama model metadata exposes its declared context window", () => {
    expect(ollamaContextWindow({
        model_info: {
            "general.architecture": "gemma3",
            "gemma3.context_length": 131_072,
        },
    })).toBe(131_072);
    expect(ollamaContextWindow({ model_info: {} })).toBeUndefined();
    expect(ollamaContextWindow({
        model_info: { "gemma3.context_length": "131072" },
    })).toBeUndefined();
});

const codexConfig = {
    schema_version: 1,
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    approval_mode: "ask",
} as unknown as VeraConfig;

function codexFixture(directory: string): string {
    const cachePath = join(directory, "models_cache.json");
    copyFileSync(
        fileURLToPath(
            new URL("../fixtures/codex-models-cache.json", import.meta.url),
        ),
        cachePath,
    );
    return cachePath;
}

function stubAuth(token: string | undefined): AuthStorage {
    return {
        getCredential: () => token === undefined
            ? undefined
            : { type: "oauth" as const, token },
        setCredential: () => {},
    } as unknown as AuthStorage;
}

test("Codex models reach the runnable list with their catalog levels", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-runtime-codex-"));
    try {
        const models = discoveredCodexModels(codexConfig, {
            cachePath: codexFixture(directory),
            cacheDir: directory,
            authStorage: stubAuth("stored-codex-credential"),
        });
        const sol = models.find((model) => model.model === "gpt-5.6-sol");

        expect(sol?.provider).toBe("openai-codex");
        expect(sol?.label).toBe("GPT-5.6-Sol");

        // The list and the levels are two different reads, and this is the
        // seam where they have to agree: the runnable entry is only useful if
        // the snapshot the same call published describes it.
        const withLevels = availableModelsWithLevels(models, {
            cacheDir: directory,
        });
        expect(
            withLevels.find((model) => model.model === "gpt-5.6-sol")
                ?.levels[0]?.id,
        ).toBe("ultra");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("no stored Codex credential means no Codex models offered", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-runtime-codex-"));
    try {
        expect(discoveredCodexModels(codexConfig, {
            cachePath: codexFixture(directory),
            cacheDir: directory,
            authStorage: stubAuth(undefined),
        })).toEqual([]);

        // Unless Codex is the provider the user configured: a model that
        // cannot authenticate should fail a turn out loud, not disappear.
        expect(discoveredCodexModels(
            { ...codexConfig, provider: "openai-codex" } as VeraConfig,
            {
                cachePath: codexFixture(directory),
                cacheDir: directory,
                authStorage: stubAuth(undefined),
            },
        ).length).toBeGreaterThan(0);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
