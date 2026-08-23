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
    discoveredDeepSeekModels,
    discoverOllamaModelCatalog,
    discoveredOllamaModels,
    discoverOmlxModelCatalog,
    ollamaContextWindow,
    replaceProviderRows,
} from "../../src/host/runtime.ts";
import { availableReasoningEfforts } from "../../src/engine/model-settings.ts";
import { readProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";

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

test("an available Ollama daemon can refresh to an empty model list", async () => {
    const result = await discoverOllamaModelCatalog({
        host: "http://127.0.0.1:11434",
        fetch: async (input) => {
            expect(String(input)).toBe("http://127.0.0.1:11434/v1/models");
            return Response.json({ data: [] });
        },
    });

    expect(result).toEqual({ available: true, models: [] });
    expect(replaceProviderRows([
        {
            provider: "ollama",
            model: "deleted:7b",
            label: "deleted:7b",
            description: "installed locally",
        },
        {
            provider: "openrouter",
            model: "kept/model",
            label: "kept/model",
            description: "remote",
        },
    ], "ollama", [])).toEqual([{
        provider: "openrouter",
        model: "kept/model",
        label: "kept/model",
        description: "remote",
    }]);
});

test("oMLX discovery lists served models and their context windows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-runtime-omlx-"));
    try {
        let authorization: string | null | undefined;
        const result = await discoverOmlxModelCatalog({
            baseUrl: "http://127.0.0.1:8000/v1",
            apiKey: "omlx-secret",
            cacheDir: directory,
            fetch: async (input, init) => {
                expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
                authorization = new Headers(init?.headers).get("authorization");
                return Response.json({
                    data: [
                        { id: "Qwen3-Coder-Next-8bit", max_model_len: 131_072 },
                        { id: "small-model" },
                    ],
                });
            },
        });

        expect(authorization).toBe("Bearer omlx-secret");
        expect(result).toMatchObject({ available: true });
        expect(result.models).toEqual([
            {
                provider: "omlx",
                model: "Qwen3-Coder-Next-8bit",
                label: "Qwen3-Coder-Next-8bit",
                description: "served locally",
                contextWindow: 131_072,
            },
            {
                provider: "omlx",
                model: "small-model",
                label: "small-model",
                description: "served locally",
            },
        ]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
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
        deleteCredential: () => {},
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

test("DeepSeek discovery publishes native models and levels after connection", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-runtime-deepseek-"));
    try {
        const config = {
            ...codexConfig,
            provider: "openrouter",
        } as VeraConfig;
        const models = discoveredDeepSeekModels(config, {
            cacheDir: directory,
            authStorage: stubAuth("stored-deepseek-key"),
        });

        expect(models.map((model) => model.model)).toEqual([
            "deepseek-v4-pro",
            "deepseek-v4-flash",
        ]);
        expect(availableModelsWithLevels(models, {
            cacheDir: directory,
        })).toEqual(expect.arrayContaining([
            expect.objectContaining({
                provider: "deepseek",
                model: "deepseek-v4-pro",
                levels: [
                    { id: "max", label: "Max" },
                    { id: "high", label: "High" },
                    { id: "off", label: "Off" },
                ],
            }),
        ]));
        expect(discoveredDeepSeekModels(config, {
            cacheDir: directory,
            authStorage: stubAuth(undefined),
        })).toEqual([]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

const OLLAMA_SHOW: Record<string, Record<string, unknown>> = {
    "granite4.1:8b": {
        capabilities: ["completion", "tools"],
        model_info: { "granite.context_length": 131_072 },
    },
    "qwen4:8b": {
        capabilities: ["completion", "tools", "thinking"],
        model_info: { "qwen4.context_length": 262_144 },
    },
    "nomic-embed:v2": { capabilities: ["embedding"] },
    "ancient:7b": { model_info: { "ancient.context_length": 8_192 } },
};

function stubOllamaHost(
    show: Record<string, Record<string, unknown>>,
    unreachable: readonly string[] = [],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async (input, init) => {
        if (String(input).endsWith("/v1/models")) {
            return Response.json({
                data: Object.keys(show).map((id) => ({ id })),
            });
        }
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        if (unreachable.includes(model)) {
            return new Response("", { status: 500 });
        }
        return Response.json(show[model]);
    };
}

test("Ollama discovery records declared capabilities as catalog levels", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-runtime-ollama-"));
    try {
        const logged: Record<string, unknown>[] = [];
        const models = await discoveredOllamaModels({
            host: "127.0.0.1:11434/",
            cacheDir: directory,
            fetch: stubOllamaHost(OLLAMA_SHOW),
            log: (entry) => logged.push(entry),
        });

        expect(models.map((model) => model.model)).toEqual([
            "granite4.1:8b",
            "qwen4:8b",
            "ancient:7b",
        ]);
        expect(models[0]).toMatchObject({
            provider: "ollama",
            label: "granite4.1:8b",
            description: "installed locally",
            contextWindow: 131_072,
        });

        // A model that lists capabilities without "thinking" has no reasoning
        // control, and saying so is what keeps the dial off it. A model whose
        // daemon declares nothing is left undescribed instead.
        expect(availableReasoningEfforts("ollama", "granite4.1:8b", {
            cacheDir: directory,
        })).toEqual([]);
        expect([...availableReasoningEfforts("ollama", "qwen4:8b", {
            cacheDir: directory,
        })].sort()).toEqual(["high", "low", "medium"]);
        expect([...availableReasoningEfforts("ollama", "ancient:7b", {
            cacheDir: directory,
        })].sort()).toEqual(["high", "low", "max", "medium"]);

        const snapshot = readProviderCatalogSnapshot("ollama", {
            cacheDir: directory,
        });
        expect(snapshot.models.map((model) => model.id)).toEqual([
            "granite4.1:8b",
            "qwen4:8b",
        ]);
        expect(snapshot.models[1]?.tool_support).toBe(true);

        expect(logged.map((entry) => entry.type)).toEqual([
            "ollama_discovery_listed",
            "ollama_model_described",
            "ollama_model_described",
            "ollama_model_described",
            "ollama_model_excluded",
            "ollama_model_described",
            "ollama_catalog_written",
        ]);
        expect(logged[0]).toMatchObject({
            host: "http://127.0.0.1:11434",
            models: Object.keys(OLLAMA_SHOW),
        });
        expect(logged[1]).toMatchObject({
            model: "granite4.1:8b",
            capabilities: ["completion", "tools"],
            context_window: 131_072,
        });
        expect(logged[4]).toMatchObject({
            model: "nomic-embed:v2",
            reason: "embedding model",
        });
        expect(logged[6]).toMatchObject({
            models: ["granite4.1:8b", "qwen4:8b"],
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("one unreachable Ollama model does not drop the others", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-runtime-ollama-"));
    try {
        const logged: Record<string, unknown>[] = [];
        const models = await discoveredOllamaModels({
            cacheDir: directory,
            fetch: stubOllamaHost(OLLAMA_SHOW, ["qwen4:8b"]),
            log: (entry) => logged.push(entry),
        });

        expect(models.map((model) => model.model)).toEqual([
            "granite4.1:8b",
            "qwen4:8b",
            "ancient:7b",
        ]);
        expect(readProviderCatalogSnapshot("ollama", { cacheDir: directory })
            .models.map((model) => model.id)).toEqual(["granite4.1:8b"]);
        expect(logged.find((entry) =>
            entry.type === "ollama_model_probe_failed"
        )).toMatchObject({ model: "qwen4:8b", reason: "HTTP 500" });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("an offline Ollama daemon yields no models", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-runtime-ollama-"));
    try {
        expect(await discoveredOllamaModels({
            cacheDir: directory,
            fetch: async () => {
                throw new Error("connection refused");
            },
        })).toEqual([]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
