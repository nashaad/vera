import { expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import {
    readProviderCatalogSnapshot,
} from "../../src/model/catalog-cache.ts";
import { refreshOpenAIProviderCatalog } from "../../src/model/openai-discovery.ts";
import { shippedProviderDefinitions } from "../../src/providers/definitions.ts";

test("disposable VERA_HOME loads DigitalOcean data and reads back a real catalog snapshot", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-digitalocean-store-"));
    const previousHome = process.env.VERA_HOME;
    const previousRuntime = process.env.VERA_RUNTIME_DIR;
    process.env.VERA_HOME = home;
    process.env.VERA_RUNTIME_DIR = join(home, "runtime");
    const profile = join(home, "profiles", "default");
    const configPath = join(profile, "config.json");
    const cacheDir = join(home, "runtime", "cache");
    try {
        const raw = {
            schema_version: 1,
            provider: "digitalocean",
            model: "account-model",
            approval_mode: "ask",
            providers: {
                digitalocean: {
                    protocol: "openai-chat",
                    base_url: "https://inference.do-ai.run/v1",
                    credential: "api_key",
                },
            },
        };
        mkdirSync(profile, { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
        const config = loadVeraConfig({ path: configPath });
        expect(config.provider).toBe("digitalocean");
        expect(shippedProviderDefinitions().some((entry) => entry.id === "digitalocean"))
            .toBe(true);
        expect(JSON.parse(readFileSync(configPath, "utf8")).providers).toBeUndefined();

        const catalog = await refreshOpenAIProviderCatalog({
            provider: "digitalocean",
            baseUrl: "https://inference.do-ai.run/v1",
            apiKey: "disposable-proof-key",
            cacheDir,
            fetch: async (_input, init) => {
                expect(new Headers(init?.headers).get("authorization"))
                    .toBe("Bearer disposable-proof-key");
                return new Response(JSON.stringify({ data: [{ id: "account-model" }] }), {
                    status: 200,
                });
            },
        });
        expect(catalog?.models.map((model) => model.id)).toEqual(["account-model"]);
        expect(readProviderCatalogSnapshot("digitalocean", { cacheDir }).models.map((model) => model.id))
            .toEqual(["account-model"]);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        if (previousRuntime === undefined) delete process.env.VERA_RUNTIME_DIR;
        else process.env.VERA_RUNTIME_DIR = previousRuntime;
        rmSync(home, { recursive: true, force: true });
    }
});
